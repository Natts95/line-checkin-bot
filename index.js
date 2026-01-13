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
const pendingCheckin = {};
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

// แปลงวันที่เป็นภาษาไทย + พ.ศ.
function getThaiDateString() {
  const date = new Date();

  const days = [
    'วันอาทิตย์',
    'วันจันทร์',
    'วันอังคาร',
    'วันพุธ',
    'วันพฤหัสบดี',
    'วันศุกร์',
    'วันเสาร์',
  ];

  const months = [
    'มกราคม',
    'กุมภาพันธ์',
    'มีนาคม',
    'เมษายน',
    'พฤษภาคม',
    'มิถุนายน',
    'กรกฎาคม',
    'สิงหาคม',
    'กันยายน',
    'ตุลาคม',
    'พฤศจิกายน',
    'ธันวาคม',
  ];

  const dayName = days[date.getDay()];
  const day = date.getDate();
  const month = months[date.getMonth()];
  const year = date.getFullYear() + 543;

  return `${dayName}ที่ ${day} ${month} ${year}`;
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
        const thaiDate = getThaiDateString();

        const profile = await client.getProfile(userId);
        const name = profile.displayName;

        if (!checkedInToday[today]) {
          checkedInToday[today] = {};
        }

        /* ===== START CHECK-IN ===== */
        if (text === 'checkin') {
          if (isSunday()) {
            await client.replyMessage(event.replyToken, {
              type: 'text',
              text: `❌ ${thaiDate} เป็นวันอาทิตย์ ${name} ไม่ต้อง check-in ค่ะ`,
            });
            continue;
          }

          if (checkedInToday[today][userId]) {
            await client.replyMessage(event.replyToken, {
              type: 'text',
              text: `⚠️ ${name} ได้ทำการ check-in สำหรับ${thaiDate} ไปแล้ว แก้ไขไม่ได้ค่ะ`,
            });
            continue;
          }

          pendingCheckin[userId] = true;

          await client.replyMessage(event.replyToken, {
            type: 'text',
            text: `${thaiDate}\n${name} วันนี้คุณทำงานแบบไหนคะ?`,
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
            text: `ทำการบันทึกการทำงาน ${thaiDate} ของ ${name} (${workType}) เรียบร้อยค่ะ`,
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
