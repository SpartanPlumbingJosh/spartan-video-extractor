# Spartan Video Extractor

A standalone service that automatically extracts key frames from videos uploaded to Slack, enabling Kate to analyze video content.

## How It Works

```
Tech uploads video to Slack
        ↓
Video Extractor detects file_shared event
        ↓
Downloads video, runs ffmpeg
        ↓
Extracts key frames (every 3 seconds by default)
        ↓
Posts frames to Slack thread
        ↓
Kate can now see and analyze the images!
```

## Supported Video Formats

- MP4, MOV, AVI, MKV, WebM, M4V, WMV, FLV

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `SLACK_BOT_TOKEN` | ✅ | - | Bot token (xoxb-...) |
| `SLACK_APP_TOKEN` | ✅ | - | App-level token (xapp-...) |
| `SLACK_SIGNING_SECRET` | ✅ | - | Signing secret |
| `FRAME_INTERVAL` | ❌ | 3 | Extract frame every N seconds |
| `MAX_FRAMES` | ❌ | 10 | Maximum frames to extract |
| `PORT` | ❌ | 8080 | Health check port |

## Slack App Setup

### 1. Create a new Slack App (or use existing)

Go to [api.slack.com/apps](https://api.slack.com/apps)

### 2. Enable Socket Mode

- Settings → Socket Mode → Enable
- Create an App-Level Token with `connections:write` scope
- Save the `xapp-...` token

### 3. Add Bot Token Scopes

OAuth & Permissions → Bot Token Scopes:
- `files:read` - Read files
- `files:write` - Upload extracted frames
- `chat:write` - Post status messages
- `reactions:read` - Read reactions
- `reactions:write` - Add processing reactions

### 4. Subscribe to Events

Event Subscriptions → Subscribe to bot events:
- `file_shared` - Triggered when files are uploaded

### 5. Install to Workspace

Install the app and copy the Bot Token (`xoxb-...`)

## Deployment to Railway

### Option 1: From GitHub

1. Push this repo to GitHub
2. Create new Railway project → Deploy from GitHub
3. Add environment variables
4. Deploy!

### Option 2: Railway CLI

```bash
# Login to Railway
railway login

# Create new project
railway init

# Add environment variables
railway variables set SLACK_BOT_TOKEN=xoxb-...
railway variables set SLACK_APP_TOKEN=xapp-...
railway variables set SLACK_SIGNING_SECRET=...

# Deploy
railway up
```

## Local Development

```bash
# Install dependencies
npm install

# Create .env file
cat > .env << EOF
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
SLACK_SIGNING_SECRET=...
FRAME_INTERVAL=3
MAX_FRAMES=10
EOF

# Run in development
npm run dev
```

## Configuration Options

### Frame Interval

Default extracts 1 frame every 3 seconds. For longer videos, consider:
- **Short videos (< 30s)**: `FRAME_INTERVAL=2`
- **Medium videos (30s-2min)**: `FRAME_INTERVAL=3` (default)
- **Long videos (> 2min)**: `FRAME_INTERVAL=5`

### Max Frames

Limits total frames extracted. Default is 10 to avoid Slack spam.
- For detailed analysis: `MAX_FRAMES=15`
- For quick overview: `MAX_FRAMES=5`

## Architecture

This service is designed as a **standalone module** that doesn't touch Kate's core codebase:

```
┌─────────────────────────────────────┐
│         KATE CORE (stable)          │
│  - Slack coaching                   │
│  - Voice calls                      │
│  - ServiceTitan lookups             │
│  - Image analysis                   │
└──────────────┬──────────────────────┘
               │ (Kate sees extracted frames)
┌──────────────┴──────────────────────┐
│     VIDEO EXTRACTOR (this service)  │
│  - Watches for video uploads        │
│  - Extracts frames with ffmpeg      │
│  - Posts frames to Slack            │
└─────────────────────────────────────┘
```

## Troubleshooting

### "Could not download video"
- Check bot has `files:read` scope
- Ensure bot is in the channel where video was uploaded

### "No frames extracted"
- Video might be corrupted
- Check Railway logs for ffmpeg errors
- Ensure ffmpeg is installed (handled by Dockerfile)

### Rate limiting
- Service waits 500ms between frame uploads
- If still hitting limits, increase delay in code

## License

Internal Spartan Plumbing tool.
