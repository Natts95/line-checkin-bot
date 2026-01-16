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
// structure: { userId: { date, workType } }

const employees = {}; 
const admins = {};

/* ======================
   Google Sheets Functions
====================== */
// ... (ฟังก์ชัน saveCheckin, saveEmployee, saveAdmin เหมือนเดิม ไม่ต้องแก้) ...
// เพื่อความกระชับ ผมขอละส่วน save... ไว้ ถ้าคุณมีของเดิมอยู่แล้วใช้ได้เลย
// แต่ถ้าต้องการให้แปะใหม่บอกได้ครับ

async function saveCheckinToSheet({ date, userId, name, workType }) {
    // ... (Code เดิมของคุณ) ...
    try {
        await auth.authorize();
        const sheets = google.sheets({ version: 'v4', auth });
        await sheets.spreadsheets.values.append({
          spreadsheetId: process.env.SPREADSHEET_ID,
          range: 'checkin!A:E',
          valueInputOption: 'USER_ENTERED',
          requestBody: { values: [[ date, userId, name, workType, new Date().toLocaleString('th-TH') ]] },
        });
    } catch (err) { console.error('❌ Save Checkin Error', err); }
}

async function saveEmployeeToSheet({ userId, name, status, adminId }) {
     // ... (Code เดิมของคุณ ใช้ logic เดิมได้เลย) ...
     try {
        await auth.authorize();
        const sheets = google.sheets({ version: 'v4', auth });
        await sheets.spreadsheets.values.append({
          spreadsheetId: process.env.SPREADSHEET_ID,
          range: 'employee!A:E',
          valueInputOption: 'USER_ENTERED',
          requestBody: { values: [[ new Date().toLocaleString('th-TH'), userId, name, status, adminId ]] },
        });
    } catch (err) { console.error('❌ Save Emp Error', err); }
}

async function saveAdminToSheet({ userId, name, status, promotedBy }) {
    // ... (Code เดิมของคุณ) ...
    try {
        await auth.authorize();
        const sheets = google.sheets({ version: 'v4', auth });
        await sheets.spreadsheets.values.append({
          spreadsheetId: process.env.SPREADSHEET_ID,
          range: 'admin!A:E',
          valueInputOption: 'USER_ENTERED',
          requestBody: { values: [[ new Date().toLocaleString('th-TH'), userId, name, status, promotedBy ]] },
        });
    } catch (err) { console.error('❌ Save Admin Error', err); }
}


// --- 🌟 NEW: Load Check-ins for TODAY (กันเหนียวตอน Restart) ---
async function loadCheckinsToday() {
  const today = getToday();
  console.log('🔄 Loading today check-ins...');
  try {
    await auth.authorize();
    const sheets = google.sheets({ version: 'v4', auth });
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.SPREADSHEET_ID,
      range: 'checkin!A:E', 
    });
    
    if (res.data.values) {
      res.data.values.forEach((row) => {
        // row[0] = date (YYYY-MM-DD), row[1] = userId, row[3] = workType
        if (row[0] === today) {
           checkinStore[row[1]] = { date: row[0], workType: row[3] };
        }
      });
    }
    console.log(`✅ Found ${Object.keys(checkinStore).length} check-ins for today.`);
  } catch (err) { console.error('❌ Load Checkin Error:', err.message); }
}

async function loadDataFromSheet() {
  // ... (Load Employee/Admin เหมือนเดิม) ...
  // *เพิ่มบรรทัดนี้เข้าไปใน loadDataFromSheet เดิมของคุณ*
  await loadCheckinsToday(); // <--- เรียก function ใหม่ที่นี่
  
  // (ส่วน Load Emp/Admin เดิม ใส่ไว้ตรงนี้เหมือนเดิมครับ)
  console.log('🔄 Loading users...');
  try {
    await auth.authorize();
    const sheets = google.sheets({ version: 'v4', auth });
    
    // Load Employees
    const empRes = await sheets.spreadsheets.values.get({ spreadsheetId: process.env.SPREADSHEET_ID, range: 'employee!A:E' });
    if (empRes.data.values) {
        empRes.data.values.forEach(row => {
            const [, uid, name, status] = row;
            if(!uid) return;
            if(status === 'active') employees[uid] = { name, active: true };
            else if(status === 'inactive' && employees[uid]) employees[uid].active = false;
        });
    }

    // Load Admins
    const admRes = await sheets.spreadsheets.values.get({ spreadsheetId: process.env.SPREADSHEET_ID, range: 'admin!A:E' });
    if (admRes.data.values) {
        admRes.data.values.forEach(row => {
            const [, uid, name, status] = row;
            if(!uid) return;
            if(status === 'active') admins[uid] = { name, active: true };
            else if(status === 'inactive' && admins[uid]) admins[uid].active = false;
        });
    }
  } catch(e) { console.error(e); }
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
function getToday() { return new Date().toISOString().split('T')[0]; }
function isSunday() { return new Date().getDay() === 0; }
function isAfter0930() { 
  const d = new Date(); 
  return d.getHours() > 9 || (d.getHours() === 9 && d.getMinutes() >= 30); 
}
function formatThaiDate() { /* ...เหมือนเดิม... */
    const d = new Date();
    const months = ['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'];
    return `${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()+543}`;
}

/* ======================
   ⏰ CRON JOBS (ตั้งเวลาทำงานอัตโนมัติ)
====================== */

// 1. 09:20 -> เตือนคนยังไม่เช็คอิน
cron.schedule('20 9 * * 1-6', async () => { // จันทร์-ศุกร์ เวลา 09:20
  console.log('⏰ Cron 09:20: Sending alerts...');
  const today = getToday();
  
  // วนลูปพนักงานทุกคนที่มีสถานะ Active
  for (const uid in employees) {
    if (employees[uid].active) {
      // ถ้าไม่มีชื่อใน checkinStore แสดงว่ายังไม่กด
      if (!checkinStore[uid] || checkinStore[uid].date !== today) {
        try {
          await client.pushMessage(uid, {
            type: 'text',
            text: `⚠️ เตือน: อีก 10 นาทีระบบจะปิด Check-in นะคะ\nกรุณากด checkin เพื่อลงเวลาค่ะ`,
          });
        } catch (e) { console.error(`Failed to alert ${uid}`); }
      }
    }
  }
}, { timezone: "Asia/Bangkok" });

// 2. 09:45 -> ส่งสรุปรายงานประจำวัน
cron.schedule('45 9 * * 1-6', async () => {
  console.log('⏰ Cron 09:45: Sending report...');
  const today = getToday();
  const dateStr = formatThaiDate();
  
  let report = `📊 สรุปการลงเวลา\nประจำวันที่ ${dateStr}\n------------------\n`;
  
  const notCheckedIn = [];
  const checkedIn = [];

  // แยกกลุ่มคนมา กับ ขาด
  for (const uid in employees) {
    if (employees[uid].active) {
      const record = checkinStore[uid];
      if (record && record.date === today) {
        // แปลง code เป็นภาษาคน
        let type = '✅ มาทำงาน';
        if (record.workType.includes('half-morning')) type = '⛅ ครึ่งเช้า';
        else if (record.workType.includes('half-afternoon')) type = '☀️ ครึ่งบ่าย';
        else if (record.workType.includes('off')) type = '🏠 หยุดงาน';
        
        checkedIn.push(`${employees[uid].name} : ${type}`);
      } else {
        notCheckedIn.push(`❌ ${employees[uid].name}`);
      }
    }
  }

  if (checkedIn.length > 0) report += checkedIn.join('\n') + '\n';
  if (notCheckedIn.length > 0) {
      report += `\n[ยังไม่เช็คอิน]\n` + notCheckedIn.join('\n');
  } else {
      report += `\n(ครบทุกคน)`;
  }

  // ส่งรายงานหา Super Admin (หรือระบุ GroupId แทนถ้าทราบ)
  const target = process.env.ADMIN_USER_ID; 
  try {
      await client.pushMessage(target, { type: 'text', text: report });
  } catch (e) { console.error('Failed to send report'); }

}, { timezone: "Asia/Bangkok" });


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

      const isSuperAdmin = userId === process.env.ADMIN_USER_ID;
      const isAdmin = isSuperAdmin || admins[userId]?.active;
      const profile = await client.getProfile(userId);
      const name = profile.displayName;

      // ... (whoami, add employee, remove employee, add/remove admin ใช้ code เดิมได้เลย) ...

       /* ===== checkin ===== */
      if (lower === 'checkin') {
        if (!isAdmin && !employees[userId]?.active) {
            await client.replyMessage(event.replyToken, { type: 'text', text: '❌ คุณยังไม่ได้เป็นพนักงานในระบบ' });
            continue;
        }

        // 🛑 NEW: ป้องกัน Check-in ซ้ำ
        if (checkinStore[userId] && checkinStore[userId].date === today) {
             // ถ้ามี record แล้ว และเป็นของวันนี้
             await client.replyMessage(event.replyToken, { 
                 type: 'text', 
                 text: `⚠️ คุณ ${name} ทำการ Check-in ของวันนี้ไปเรียบร้อยแล้วค่ะ` 
             });
             continue;
        }

        if (isSunday()) { /* ... */ continue; }
        if (isAfter0930() && !isAdmin) { /* ... */ continue; }

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
        // ... (Logic บันทึกเหมือนเดิม) ...
        try {
            // เช็คซ้ำอีกรอบก่อนบันทึกเผื่อมือกดรัวๆ
            if (checkinStore[userId] && checkinStore[userId].date === today) return; 

            checkinStore[userId] = { date: today, workType: lower };
            await saveCheckinToSheet({ date: today, userId, name, workType: lower });
            await client.replyMessage(event.replyToken, { type: 'text', text: `✅ บันทึกเรียบร้อย\n${thaiDate}\n${name}` });
        } catch (err) { /*...*/ }
      }
      
      // ... (Logic อื่นๆ) ...
    }
    res.sendStatus(200);
  } catch (e) { console.error(e); res.sendStatus(500); }
});

/* ======================
   Start Server
====================== */
const PORT = process.env.PORT || 3000;
loadDataFromSheet().then(() => {
  app.listen(PORT, () => console.log(`🚀 Server running on ${PORT}`));
});