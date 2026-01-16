const express = require('express');
const line = require('@line/bot-sdk');
const cron = require('node-cron');
const { google } = require('googleapis');

/* ======================
   Google Sheets Auth
====================== */
const auth = new google.auth.JWT({
  email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
  key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

/* ======================
   Memory Store
====================== */
const checkinStore = {};
const employees = {}; 
// structure: { userId: { name: String, active: Boolean } }

/* ======================
   Google Sheets Functions
====================== */

// 1. ฟังก์ชันบันทึกการลงเวลา (Check-in)
async function saveCheckinToSheet({ date, userId, name, workType }) {
  try {
    await auth.authorize();
    const sheets = google.sheets({ version: 'v4', auth });

    await sheets.spreadsheets.values.append({
      spreadsheetId: process.env.SPREADSHEET_ID,
      range: 'checkin!A:E',
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [[
          date,
          userId,
          name,
          workType,
          new Date().toLocaleString('th-TH'),
        ]],
      },
    });
    console.log(`📝 Check-in Saved: ${name}`);
  } catch (err) {
    console.error('❌ SAVE CHECKIN ERROR:', err.message);
    throw err;
  }
}

// 2. ฟังก์ชันบันทึกประวัติพนักงาน (Role Log) ลง Sheet 'employee'
async function saveEmployeeToSheet({ userId, name, status, adminId }) {
  try {
    await auth.authorize();
    const sheets = google.sheets({ version: 'v4', auth });

    await sheets.spreadsheets.values.append({
      spreadsheetId: process.env.SPREADSHEET_ID,
      range: 'employee!A:E', // ตรวจสอบว่ามี Tab ชื่อ employee
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [[
          new Date().toLocaleString('th-TH'), // Time
          userId,
          name,
          status, // 'active' or 'inactive'
          adminId // Admin UserID
        ]],
      },
    });
    console.log(`📝 Employee Log Saved: ${name} (${status})`);
  } catch (err) {
    console.error('❌ SAVE EMPLOYEE ERROR:', err.message);
    // ไม่ throw เพื่อให้บอททำงานต่อได้ แม้บันทึก log ไม่สำเร็จ
  }
}

// 3. ฟังก์ชันโหลดข้อมูลพนักงานเข้า Memory ตอนเริ่ม Server
async function loadEmployeesFromSheet() {
  console.log('🔄 Loading employees from Google Sheet...');
  try {
    await auth.authorize();
    const sheets = google.sheets({ version: 'v4', auth });

    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.SPREADSHEET_ID,
      range: 'employee!A:E', 
    });

    const rows = response.data.values;
    if (rows && rows.length) {
      rows.forEach((row) => {
        // สมมติลำดับ Column: [Time, UserID, Name, Status, AdminID]
        const [, userId, name, status] = row;
        
        // ข้าม Header หรือแถวที่ไม่มี UserID
        if (!userId || userId.toLowerCase() === 'userid') return;

        // Logic: อัปเดตข้อมูลล่าสุดลงใน Memory
        // ถ้าเจอ active ก็ set active, ถ้าเจอ inactive ก็ set inactive
        // การวนลูปจากบนลงล่าง จะทำให้เราได้สถานะล่าสุดเสมอ
        if (status === 'active') {
          employees[userId] = { name: name, active: true };
        } else if (status === 'inactive') {
          if (employees[userId]) {
            employees[userId].active = false;
          }
        }
      });
      console.log(`✅ Loaded ${Object.keys(employees).length} employees into memory.`);
    } else {
      console.log('⚠️ No employee data found.');
    }
  } catch (err) {
    console.error('❌ LOAD EMPLOYEES ERROR:', err.message);
  }
}

/* ======================
   Express + LINE
====================== */
const app = express();

const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET,
};

const client = new line.Client(config);

/* ======================
   Helpers
====================== */
function getToday() {
  return new Date().toISOString().split('T')[0];
}

function isSunday() {
  return new Date().getDay() === 0;
}

function isAfter0930() {
  const d = new Date();
  return d.getHours() > 9 || (d.getHours() === 9 && d.getMinutes() >= 30);
}

function formatThaiDate() {
  const d = new Date();
  const days = ['อาทิตย์','จันทร์','อังคาร','พุธ','พฤหัสบดี','ศุกร์','เสาร์'];
  const months = [
    'มกราคม','กุมภาพันธ์','มีนาคม','เมษายน','พฤษภาคม','มิถุนายน',
    'กรกฎาคม','สิงหาคม','กันยายน','ตุลาคม','พฤศจิกายน','ธันวาคม',
  ];
  return `วัน${days[d.getDay()]}ที่ ${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear() + 543}`;
}

/* ======================
   Webhook
====================== */
app.post('/webhook', line.middleware(config), async (req, res) => {
  try {
    for (const event of req.body.events) {
      if (event.type !== 'message' || event.message.type !== 'text') continue;

      const userId = event.source.userId;
      const text = event.message.text.trim();
      const lower = text.toLowerCase();
      const today = getToday();
      const thaiDate = formatThaiDate();

      const isAdmin = userId === process.env.ADMIN_USER_ID;

      const profile = await client.getProfile(userId);
      const name = profile.displayName;

      /* ===== whoami ===== */
      if (lower === 'whoami') {
        const empStatus = employees[userId]?.active ? 'Employee (Active)' : 'Guest/Inactive';
        await client.replyMessage(event.replyToken, {
          type: 'text',
          text: `👤 ${name}\nuserId:\n${userId}\nrole: ${isAdmin ? 'Admin' : empStatus}`,
        });
        continue;
      }

      /* ===== ADMIN: add employee ===== */
      if (lower.startsWith('add employee')) {
        if (!isAdmin) {
          await client.replyMessage(event.replyToken, {
            type: 'text', text: '❌ คำสั่งนี้สำหรับ admin เท่านั้น'
          });
          continue;
        }

        const [, , empId, ...empNameParts] = text.split(' ');
        const empName = empNameParts.join(' ') || 'Employee';

        if (!empId) {
          await client.replyMessage(event.replyToken, {
            type: 'text', text: '⚠️ ใช้คำสั่ง: add employee <userId> <name>'
          });
          continue;
        }

        // 1. Update Memory
        employees[empId] = { name: empName, active: true };

        // 2. Save to Sheet
        await saveEmployeeToSheet({
          userId: empId,
          name: empName,
          status: 'active',
          adminId: userId
        });

        await client.replyMessage(event.replyToken, {
          type: 'text',
          text: `✅ เพิ่มพนักงานสำเร็จ\nชื่อ: ${empName}\nสถานะ: Active`,
        });
        continue;
      }

      /* ===== ADMIN: remove employee ===== */
      if (lower.startsWith('remove employee')) {
        if (!isAdmin) {
          await client.replyMessage(event.replyToken, {
            type: 'text', text: '❌ คำสั่งนี้สำหรับ admin เท่านั้น'
          });
          continue;
        }

        const [, , empId] = text.split(' ');
        const targetName = employees[empId]?.name || 'Unknown';

        if (!employees[empId]) {
          await client.replyMessage(event.replyToken, {
            type: 'text', text: '⚠️ ไม่พบ employee นี้ในระบบ'
          });
          continue;
        }

        // 1. Update Memory
        employees[empId].active = false;

        // 2. Save to Sheet
        await saveEmployeeToSheet({
          userId: empId,
          name: targetName,
          status: 'inactive',
          adminId: userId
        });

        await client.replyMessage(event.replyToken, {
          type: 'text',
          text: `⛔ ปิดสถานะพนักงานเรียบร้อย\nชื่อ: ${targetName}`,
        });
        continue;
      }

      /* ===== checkin ===== */
      if (lower === 'checkin') {
        // เช็คว่า User เป็น Active Employee หรือไม่ (และไม่ใช่ Admin)
        if (!isAdmin && !employees[userId]?.active) {
          await client.replyMessage(event.replyToken, {
            type: 'text',
            text: '❌ คุณยังไม่ได้เป็นพนักงานในระบบ\nโปรดติดต่อ Admin',
          });
          continue;
        }

        if (isSunday()) {
          await client.replyMessage(event.replyToken, {
            type: 'text', text: '❌ วันอาทิตย์ไม่ต้อง check-in ค่ะ'
          });
          continue;
        }

        if (isAfter0930() && !isAdmin) {
          await client.replyMessage(event.replyToken, {
            type: 'text', text: '⛔ ระบบปิด check-in แล้ว (หลัง 09:30)'
          });
          continue;
        }

        await client.replyMessage(event.replyToken, {
          type: 'template',
          altText: 'เลือกประเภทงาน',
          template: {
            type: 'buttons',
            text: `${thaiDate}\n${name} วันนี้คุณทำงานแบบไหนคะ`,
            actions: [
              { label: 'ทำงานเต็มวัน', type: 'message', text: 'work:full' },
              { label: 'ครึ่งวันเช้า', type: 'message', text: 'work:half-morning' },
              { label: 'ครึ่งวันบ่าย', type: 'message', text: 'work:half-afternoon' },
              { label: 'หยุดงาน', type: 'message', text: 'work:off' },
            ],
          },
        });
        continue;
      }

      /* ===== work result ===== */
      if (lower.startsWith('work:')) {
        // Optional Check: ถ้าอยากให้มั่นใจว่าคนกดคือ Employee จริงๆ ให้ uncomment บรรทัดล่าง
        // if (!isAdmin && !employees[userId]?.active) return;

        try {
            checkinStore[userId] = { date: today, workType: lower };
    
            await saveCheckinToSheet({
              date: today,
              userId,
              name,
              workType: lower,
            });
    
            await client.replyMessage(event.replyToken, {
              type: 'text',
              text: `✅ บันทึกเรียบร้อย\n${thaiDate}\n${name}`,
            });
        } catch (err) {
            await client.replyMessage(event.replyToken, {
                type: 'text',
                text: `❌ เกิดข้อผิดพลาดในการบันทึก: ${err.message}`,
            });
        }
      }
    }

    res.sendStatus(200);
  } catch (e) {
    console.error('WEBHOOK ERROR:', e);
    res.sendStatus(500);
  }
});

/* ======================
   Start Server
====================== */
const PORT = process.env.PORT || 3000;

// โหลดข้อมูลพนักงานก่อนเริ่มเปิดรับ Request
loadEmployeesFromSheet().then(() => {
  app.listen(PORT, () => console.log(`🚀 Server running on ${PORT}`));
});