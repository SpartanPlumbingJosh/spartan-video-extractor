import { App, LogLevel } from '@slack/bolt';
import { WebClient } from '@slack/web-api';
import axios from 'axios';
import ffmpeg from 'fluent-ffmpeg';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createServer } from 'http';

// Environment variables
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN!;
const SLACK_APP_TOKEN = process.env.SLACK_APP_TOKEN!;
const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET!;
const FRAME_INTERVAL = parseInt(process.env.FRAME_INTERVAL || '3'); // Extract frame every N seconds
const MAX_FRAMES = parseInt(process.env.MAX_FRAMES || '10'); // Max frames to extract
const PORT = parseInt(process.env.PORT || '8080');

// Video file extensions we support
const VIDEO_EXTENSIONS = ['.mp4', '.mov', '.avi', '.mkv', '.webm', '.m4v', '.wmv', '.flv'];

// Initialize Slack
const app = new App({
  token: SLACK_BOT_TOKEN,
  appToken: SLACK_APP_TOKEN,
  socketMode: true,
  logLevel: LogLevel.INFO,
});

const slackClient = new WebClient(SLACK_BOT_TOKEN);

console.log(`
========================================
  📹 SPARTAN VIDEO EXTRACTOR v1.0.0
========================================
`);

// Listen for file shared events
app.event('file_shared', async ({ event, client }) => {
  try {
    const fileId = event.file_id;
    const channelId = event.channel_id;
    
    console.log(`[Video] File shared in ${channelId}: ${fileId}`);
    
    // Get file info
    const fileInfo = await client.files.info({ file: fileId });
    const file = fileInfo.file;
    
    if (!file) {
      console.log('[Video] Could not get file info');
      return;
    }
    
    // Check if it's a video
    const fileName = file.name || '';
    const fileExt = path.extname(fileName).toLowerCase();
    const mimeType = file.mimetype || '';
    
    const isVideo = VIDEO_EXTENSIONS.includes(fileExt) || mimeType.startsWith('video/');
    
    if (!isVideo) {
      console.log(`[Video] Not a video file: ${fileName} (${mimeType})`);
      return;
    }
    
    console.log(`[Video] 🎬 Processing video: ${fileName}`);
    
    // React to show we're processing
    const shares = file.shares?.public || file.shares?.private;
    let messageTs: string | undefined;
    
    if (shares && shares[channelId]) {
      messageTs = shares[channelId][0]?.ts;
    }
    
    if (messageTs) {
      await client.reactions.add({
        channel: channelId,
        timestamp: messageTs,
        name: 'hourglass_flowing_sand'
      }).catch(() => {}); // Ignore if already reacted
    }
    
    // Post processing message
    const statusMsg = await client.chat.postMessage({
      channel: channelId,
      thread_ts: messageTs,
      text: `📹 Processing video "${fileName}"... extracting key frames for analysis.`
    });
    
    // Download the video
    const downloadUrl = file.url_private_download || file.url_private;
    if (!downloadUrl) {
      console.log('[Video] No download URL available');
      await client.chat.update({
        channel: channelId,
        ts: statusMsg.ts!,
        text: '❌ Could not download video - no URL available.'
      });
      return;
    }
    
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spartan-video-'));
    const videoPath = path.join(tempDir, fileName);
    const framesDir = path.join(tempDir, 'frames');
    fs.mkdirSync(framesDir);
    
    console.log(`[Video] Downloading to ${videoPath}`);
    
    // Download video file
    const response = await axios({
      method: 'GET',
      url: downloadUrl,
      responseType: 'stream',
      headers: {
        'Authorization': `Bearer ${SLACK_BOT_TOKEN}`
      }
    });
    
    const writer = fs.createWriteStream(videoPath);
    response.data.pipe(writer);
    
    await new Promise<void>((resolve, reject) => {
      writer.on('finish', resolve);
      writer.on('error', reject);
    });
    
    console.log('[Video] Download complete, extracting frames...');
    
    // Extract frames using ffmpeg
    const frames = await extractFrames(videoPath, framesDir, FRAME_INTERVAL, MAX_FRAMES);
    
    if (frames.length === 0) {
      console.log('[Video] No frames extracted');
      await client.chat.update({
        channel: channelId,
        ts: statusMsg.ts!,
        text: '❌ Could not extract frames from video.'
      });
      cleanup(tempDir);
      return;
    }
    
    console.log(`[Video] Extracted ${frames.length} frames, uploading...`);
    
    // Update status
    await client.chat.update({
      channel: channelId,
      ts: statusMsg.ts!,
      text: `📹 Extracted ${frames.length} key frames from "${fileName}". Uploading...`
    });
    
    // Upload frames to Slack
    for (let i = 0; i < frames.length; i++) {
      const framePath = frames[i];
      const frameBuffer = fs.readFileSync(framePath);
      
      await client.files.uploadV2({
        channel_id: channelId,
        thread_ts: messageTs,
        filename: `frame_${i + 1}_of_${frames.length}.jpg`,
        file: frameBuffer,
        initial_comment: i === 0 
          ? `🖼️ Frame ${i + 1}/${frames.length} (${formatTimestamp(i * FRAME_INTERVAL)})`
          : `🖼️ Frame ${i + 1}/${frames.length} (${formatTimestamp(i * FRAME_INTERVAL)})`
      });
      
      // Small delay to avoid rate limits
      await sleep(500);
    }
    
    // Final update
    await client.chat.update({
      channel: channelId,
      ts: statusMsg.ts!,
      text: `✅ Extracted ${frames.length} key frames from "${fileName}". Kate can now analyze these images!`
    });
    
    // Remove processing reaction, add complete
    if (messageTs) {
      await client.reactions.remove({
        channel: channelId,
        timestamp: messageTs,
        name: 'hourglass_flowing_sand'
      }).catch(() => {});
      
      await client.reactions.add({
        channel: channelId,
        timestamp: messageTs,
        name: 'white_check_mark'
      }).catch(() => {});
    }
    
    // Cleanup
    cleanup(tempDir);
    console.log(`[Video] ✅ Complete! ${frames.length} frames uploaded.`);
    
  } catch (error) {
    console.error('[Video] Error processing video:', error);
  }
});

// Extract frames from video
function extractFrames(videoPath: string, outputDir: string, interval: number, maxFrames: number): Promise<string[]> {
  return new Promise((resolve, reject) => {
    // First, get video duration
    ffmpeg.ffprobe(videoPath, (err, metadata) => {
      if (err) {
        console.error('[Video] ffprobe error:', err);
        reject(err);
        return;
      }
      
      const duration = metadata.format.duration || 0;
      console.log(`[Video] Duration: ${duration}s`);
      
      // Calculate actual interval to not exceed max frames
      let actualInterval = interval;
      const potentialFrames = Math.floor(duration / interval);
      if (potentialFrames > maxFrames) {
        actualInterval = Math.floor(duration / maxFrames);
      }
      
      const outputPattern = path.join(outputDir, 'frame_%03d.jpg');
      
      ffmpeg(videoPath)
        .outputOptions([
          `-vf fps=1/${actualInterval}`, // Extract 1 frame every N seconds
          '-q:v 2', // High quality JPEG
          '-frames:v ' + maxFrames // Max frames limit
        ])
        .output(outputPattern)
        .on('end', () => {
          // Get list of extracted frames
          const frames = fs.readdirSync(outputDir)
            .filter(f => f.endsWith('.jpg'))
            .sort()
            .map(f => path.join(outputDir, f));
          resolve(frames);
        })
        .on('error', (err) => {
          console.error('[Video] ffmpeg error:', err);
          reject(err);
        })
        .run();
    });
  });
}

// Format timestamp for display
function formatTimestamp(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

// Cleanup temp directory
function cleanup(dir: string) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    console.log(`[Video] Cleaned up ${dir}`);
  } catch (e) {
    console.error('[Video] Cleanup error:', e);
  }
}

// Sleep helper
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Health check server
const server = createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service: 'spartan-video-extractor' }));
  } else {
    res.writeHead(404);
    res.end('Not Found');
  }
});

// Start the app
(async () => {
  await app.start();
  server.listen(PORT, () => {
    console.log(`✅ Video Extractor listening via Socket Mode`);
    console.log(`✅ Health check on port ${PORT}`);
    console.log(`📹 Frame interval: every ${FRAME_INTERVAL} seconds`);
    console.log(`📹 Max frames: ${MAX_FRAMES}`);
    console.log(`
========================================
  Video Extractor is ready!
========================================
`);
  });
})();
