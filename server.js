const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3456;

// Serve static files from public directory
app.use(express.static(path.join(__dirname, 'public')));

// Parse JSON bodies
app.use(express.json({ limit: '10mb' }));

// Main page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Teleprompter page
app.get('/teleprompter', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'teleprompter.html'));
});

app.listen(PORT, () => {
  console.log(`\n  Sayette is running!`);
  console.log(`  Open http://localhost:${PORT} in Chrome or Edge\n`);
  console.log(`  Note: Web Speech API works best in Chrome.\n`);
});
