/* ======================
   PART 1 : Import & App
====================== */
const express = require('express');
const line = require('@line/bot-sdk');

const app = express();

/* ======================
   PART 2 : LINE Config
====================== */
const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET,
};

const client = new line.Client(config);

/* ======================
   PART 3 : In-memory state
====================== */
// คนที่กำลังเลือกปุ่ม
const pendingCheckin = {};

// คนที่ check-in วันนี้แล้ว
const checkedInToday = {};

/* ======================
   PART 4 : Helper functions
====================== */
function isSunday() {
  return new Date().getDay() === 0;
}

function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

/* ======================
   PART 5 : Debug log
====================== */
app.use((req, res, next) => {
  console.log('➡️ incoming:', req.method, req.url);
  next();
});

/* ======================
   PART 6 : Root & Health
====================== */
app.get('/', (req, res) => {
  res.send('LINE Bot is running 🚀');
});

app.get('/health', (req, res) => {
  res.send('OK');
});

/* ======================
   PART 7 : LINE Webhook
====================== */
app.post(
  '/webhook',
  line.middleware(config),
  async (req, res) => {
    try {
      const events = req.body.events;

      for (const event of events) {
        if (event.type !== 'message') continue;
        if (event.message.type !== 'text') continue;

        const userId = event.source.userId;
        const text = event.message.text.trim().toLowerCase();
        const today = todayKey();

        // ดึงชื่อ user
        const profile = await client.getProfile(userId);
        const name = profile.displayName;

        // init วัน
        if (!checkedInToday[today]) {
          checkedInToday[today] = {};
        }

        /* ===== START CHECK-IN ===== */
        if (text === 'checkin') {
          if (isSunday()) {
            await client.replyMessage(event.replyToken, {
              type: 'text',
              text: `❌ วันนี้วันอาทิตย์ ${name} ไม่ต้อง check-in ค่ะ`,
            });
            continue;
          }

          if (checkedInToday[today][userId]) {
            await client.replyMessage(event.replyToken, {
              type: 'text',
              text: `⚠️ ${name} คุณ check-in วันนี้ไปแล้ว แก้ไขไม่ได้ค่ะ`,
            });
            continue;
          }

          pendingCheckin[userId] = true;

          await client.replyMessage(event.replyToken, {
            type: 'text',
            text: `${name} วันนี้คุณทำงานแบบไหน?`,
            quickReply: {
              items: [
                {
                  type: 'action',
                  action: {
                    type: 'message',
                    label: '✅ เต็มวัน',
                    text: 'work_full',
                  },
                },
                {
                  type: 'action',
                  action: {
                    type: 'message',
                    label: '🌤 ครึ่งวันเช้า',
                    text: 'work_morning',
                  },
                },
                {
                  type: 'action',
                  action: {
                    type: 'message',
                    label: '🌙 ครึ่งวันบ่าย',
                    text: 'work_afternoon',
                  },
                },
                {
                  type: 'action',
                  action: {
                    type: 'message',
                    label: '❌ หยุดงาน',
                    text: 'work_off',
                  },
                },
              ],
            },
          });
          continue;
        }

        /* ===== RECEIVE WORK TYPE ===== */
        if (pendingCheckin[userId]) {
          let workType = null;

          if (text === 'work_full') workType = 'เต็มวัน';
          if (text === 'work_morning') workType = 'ครึ่งวันเช้า';
          if (text === 'work_afternoon') workType = 'ครึ่งวันบ่าย';
          if (text === 'work_off') workType = 'หยุดงาน';

          if (!workType) {
            await client.replyMessage(event.replyToken, {
              type: 'text',
              text: `${name} กรุณาเลือกจากปุ่มเท่านั้นค่ะ`,
            });
            continue;
          }

          delete pendingCheckin[userId];
          checkedInToday[today][userId] = workType;

          await client.replyMessage(event.replyToken, {
            type: 'text',
            text: `✅ ${name} บันทึกการทำงานวันนี้: ${workType} เรียบร้อยแล้ว`,
          });
          continue;
        }

        /* ===== DEFAULT ===== */
        await client.replyMessage(event.replyToken, {
          type: 'text',
          text: `สวัสดี ${name} 👋 พิมพ์ "checkin" เพื่อเริ่มลงเวลาทำงานค่ะ`,
        });
      }

      res.sendStatus(200);
    } catch (err) {
      console.error('❌ error:', err);
      res.sendStatus(500);
    }
  }
);

/* ======================
   PART 8 : Start Server
====================== */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
