const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = 3001;

// ── MIDDLEWARE ──
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// ── SIMPLE JSON DATABASE (No Python / No Compile needed!) ──
const DB_FILE = path.join(__dirname, 'library_data.json');

function loadDB() {
  if (!fs.existsSync(DB_FILE)) {
    const empty = { users: [], library: [], records: [], requests: [], history: [] };
    fs.writeFileSync(DB_FILE, JSON.stringify(empty, null, 2));
    return empty;
  }
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch {
    return { users: [], library: [], records: [], requests: [], history: [] };
  }
}

function saveDB(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

function nextId(arr) {
  return arr.length === 0 ? 1 : Math.max(...arr.map(x => x.id)) + 1;
}

function addHistory(type, title, sub = '') {
  const db = loadDB();
  db.history.unshift({ id: nextId(db.history), type, title, sub, ts: new Date().toISOString() });
  if (db.history.length > 500) db.history = db.history.slice(0, 500);
  saveDB(db);
}

function calcFine(issueDate, returnDate) {
  const s = new Date(issueDate);
  const e = new Date(returnDate);
  s.setHours(0,0,0,0); e.setHours(0,0,0,0);
  const days = Math.floor((e - s) / 86400000) + 1;
  return days > 10 ? (days - 10) * 5 : 0;
}

// ════════════════════════════════════════
//  AUTH ROUTES
// ════════════════════════════════════════

// REGISTER
app.post('/api/auth/register', (req, res) => {
  const { name, email, password, role } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'All fields required' });
  const validRole = ['student', 'admin'].includes(role) ? role : 'student';
  const db = loadDB();
  if (db.users.find(u => u.email === email.trim().toLowerCase())) {
    return res.status(409).json({ error: 'Email already registered' });
  }
  const hashed = bcrypt.hashSync(password, 10);
  const user = { id: nextId(db.users), name: name.trim(), email: email.trim().toLowerCase(), password: hashed, role: validRole, created_at: new Date().toISOString() };
  db.users.push(user);
  saveDB(db);
  res.json({ id: user.id, name: user.name, email: user.email, role: user.role });
});

// LOGIN
app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  const db = loadDB();
  const user = db.users.find(u => u.email === email.trim().toLowerCase());
  if (!user) return res.status(401).json({ error: 'Invalid email or password' });
  const valid = bcrypt.compareSync(password, user.password);
  if (!valid) return res.status(401).json({ error: 'Invalid email or password' });
  res.json({ id: user.id, name: user.name, email: user.email, role: user.role });
});

// ════════════════════════════════════════
//  LIBRARY ROUTES
// ════════════════════════════════════════

app.get('/api/library', (req, res) => {
  const db = loadDB();
  res.json([...db.library].reverse());
});

app.post('/api/library', (req, res) => {
  const { book, author, genre, total } = req.body;
  if (!book || !author || !total) return res.status(400).json({ error: 'Book name, author and copies required' });
  const db = loadDB();
  const newBook = { id: nextId(db.library), book: book.trim(), author: author.trim(), genre: (genre || '').trim(), total: parseInt(total), issued: 0, created_at: new Date().toISOString() };
  db.library.push(newBook);
  saveDB(db);
  res.json(newBook);
});

app.delete('/api/library/:id', (req, res) => {
  const db = loadDB();
  db.library = db.library.filter(b => b.id !== parseInt(req.params.id));
  saveDB(db);
  res.json({ success: true });
});

// ════════════════════════════════════════
//  RECORDS ROUTES
// ════════════════════════════════════════

app.get('/api/records', (req, res) => {
  const db = loadDB();
  res.json([...db.records].reverse());
});

app.post('/api/records', (req, res) => {
  const { student, studentId, book, issueDate, issueTime, returnDate } = req.body;
  if (!student || !book || !issueDate || !returnDate) return res.status(400).json({ error: 'Missing required fields' });
  const db = loadDB();
  const libBook = db.library.find(b => b.book.toLowerCase() === book.trim().toLowerCase());
  if (!libBook) return res.status(404).json({ error: 'Book not found in inventory' });
  if (libBook.total - libBook.issued <= 0) return res.status(400).json({ error: 'No copies available' });
  libBook.issued++;
  const record = { id: nextId(db.records), student: student.trim(), studentId: (studentId || '').trim(), book: book.trim(), issueDate, issueTime: issueTime || '', returnDate, actualReturnDate: null, returned: false, finePaid: false, created_at: new Date().toISOString() };
  db.records.push(record);
  saveDB(db);
  addHistory('issued', `"${book}" issued to ${student}`, `Issue: ${issueDate} → Return: ${returnDate}`);
  res.json(record);
});

app.post('/api/records/self-borrow', (req, res) => {
  const { studentName, studentEmail, bookId } = req.body;
  if (!studentName || !bookId) return res.status(400).json({ error: 'Missing required fields' });
  const db = loadDB();
  const libBook = db.library.find(b => b.id === parseInt(bookId));
  if (!libBook) return res.status(404).json({ error: 'Book not found' });
  if (libBook.total - libBook.issued <= 0) return res.status(400).json({ error: 'No copies available' });
  const issueDate = new Date().toISOString().split('T')[0];
  const returnDate = new Date(Date.now() + 10 * 86400000).toISOString().split('T')[0];
  const issueTime = new Date().toTimeString().slice(0, 5);
  libBook.issued++;
  const record = { id: nextId(db.records), student: studentName.trim(), studentId: studentEmail || '', book: libBook.book, issueDate, issueTime, returnDate, actualReturnDate: null, returned: false, finePaid: false, created_at: new Date().toISOString() };
  db.records.push(record);
  saveDB(db);
  addHistory('issued', `"${libBook.book}" self-borrowed by ${studentName}`, `Return by: ${returnDate}`);
  res.json(record);
});

app.patch('/api/records/:id/return', (req, res) => {
  const db = loadDB();
  const record = db.records.find(r => r.id === parseInt(req.params.id));
  if (!record) return res.status(404).json({ error: 'Record not found' });
  if (record.returned) return res.status(400).json({ error: 'Already returned' });
  const actualReturnDate = new Date().toISOString().split('T')[0];
  record.returned = true;
  record.actualReturnDate = actualReturnDate;
  const libBook = db.library.find(b => b.book.toLowerCase() === record.book.toLowerCase());
  if (libBook) libBook.issued = Math.max(0, libBook.issued - 1);
  saveDB(db);
  addHistory('returned', `"${record.book}" returned by ${record.student}`, `Returned on: ${actualReturnDate}`);
  res.json({ success: true, actualReturnDate });
});

app.patch('/api/records/:id/pay-fine', (req, res) => {
  const db = loadDB();
  const record = db.records.find(r => r.id === parseInt(req.params.id));
  if (!record) return res.status(404).json({ error: 'Record not found' });
  record.finePaid = true;
  const fine = calcFine(record.issueDate, record.returnDate);
  saveDB(db);
  addHistory('fine', `Fine of ₹${fine} paid by ${record.student}`, `Book: "${record.book}"`);
  res.json({ success: true });
});

app.put('/api/records/:id', (req, res) => {
  const { student, studentId, book, issueDate, issueTime, returnDate } = req.body;
  const db = loadDB();
  const record = db.records.find(r => r.id === parseInt(req.params.id));
  if (!record) return res.status(404).json({ error: 'Record not found' });
  Object.assign(record, { student, studentId: studentId || '', book, issueDate, issueTime: issueTime || '', returnDate });
  saveDB(db);
  res.json({ success: true });
});

app.delete('/api/records/:id', (req, res) => {
  const db = loadDB();
  const record = db.records.find(r => r.id === parseInt(req.params.id));
  if (record && !record.returned) {
    const libBook = db.library.find(b => b.book.toLowerCase() === record.book.toLowerCase());
    if (libBook) libBook.issued = Math.max(0, libBook.issued - 1);
  }
  db.records = db.records.filter(r => r.id !== parseInt(req.params.id));
  saveDB(db);
  res.json({ success: true });
});

// ════════════════════════════════════════
//  FRIEND REQUESTS ROUTES
// ════════════════════════════════════════

app.get('/api/requests', (req, res) => {
  const db = loadDB();
  res.json([...db.requests].reverse());
});

app.post('/api/requests', (req, res) => {
  const { yourName, friendName, book, msg } = req.body;
  if (!yourName || !friendName || !book) return res.status(400).json({ error: 'Required fields missing' });
  const db = loadDB();
  const date = new Date().toISOString().split('T')[0];
  const req2 = { id: nextId(db.requests), yourName: yourName.trim(), friendName: friendName.trim(), book: book.trim(), msg: (msg || '').trim(), date, status: 'Pending', created_at: new Date().toISOString() };
  db.requests.push(req2);
  saveDB(db);
  addHistory('request', `${yourName} requested "${book}" from ${friendName}`, msg || '');
  res.json(req2);
});

app.patch('/api/requests/:id/status', (req, res) => {
  const { status } = req.body;
  if (!['Pending', 'Accepted', 'Declined'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
  const db = loadDB();
  const request = db.requests.find(r => r.id === parseInt(req.params.id));
  if (!request) return res.status(404).json({ error: 'Request not found' });
  request.status = status;
  saveDB(db);
  res.json({ success: true });
});

app.delete('/api/requests/:id', (req, res) => {
  const db = loadDB();
  db.requests = db.requests.filter(r => r.id !== parseInt(req.params.id));
  saveDB(db);
  res.json({ success: true });
});

// ════════════════════════════════════════
//  HISTORY ROUTES
// ════════════════════════════════════════

app.get('/api/history', (req, res) => {
  const db = loadDB();
  res.json(db.history.slice(0, 500));
});

app.delete('/api/history', (req, res) => {
  const db = loadDB();
  db.history = [];
  saveDB(db);
  res.json({ success: true });
});

// ════════════════════════════════════════
//  NOTIFICATIONS
// ════════════════════════════════════════
app.post('/api/notifications/send-now', (req, res) => {
  const db = loadDB();
  const today = new Date().toISOString().split('T')[0];
  const overdue = db.records.filter(r => !r.returned && r.returnDate < today);
  addHistory('fine', `Notifications sent for ${overdue.length} overdue book(s)`, `Triggered manually`);
  res.json({ message: `Notifications sent for ${overdue.length} overdue book(s)` });
});

// ── START SERVER ──
app.listen(PORT, () => {
  console.log(`\n✅  Library Management System Backend`);
  console.log(`🚀  Server running at: http://localhost:${PORT}`);
  console.log(`📚  Database file:     library_data.json`);
  console.log(`\n   Open browser and visit http://localhost:${PORT}\n`);
});
