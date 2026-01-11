const express = require('express');
const line = require('@line/bot-sdk');

const app = express();

/* ======================
   LINE config
====================== */
const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET,
};

const client = new line.Client(config);

/* ======================
   Log ทุก request (debug)
====================== */
app.use((req, res, next) => {
  console.log('➡️ incoming:', req.method, req.url);
  next();
});

/* ======================
   Root (ไว้ปลุก Render)
====================== */
app.get('/', (req, res) => {
  res.status(200).send('LINE Bot is running 🚀');
});

/* ======================
   Health check (UptimeRobot)
====================== */
app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

/* ======================
   LINE Webhook
====================== */
app.post(
  '/webhook',
  line.middleware(config),
  async (req, res) => {
    try {
      const events = req.body.events;

      for (const event of events) {
        if (event.type === 'message' && event.message.type === 'text') {
          await client.replyMessage(event.replyToken, {
            type: 'text',
            text: `คุณพิมพ์ว่า: ${event.message.text}`,
          });
        }
      }

      res.sendStatus(200);
    } catch (err) {
      console.error('❌ error:', err);
      res.sendStatus(500);
    }
  }
);

/* ======================
   Start server
====================== */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
