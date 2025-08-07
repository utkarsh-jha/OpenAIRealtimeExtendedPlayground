const express = require('express');
const path = require('path');

const app = express();

// Serve static files (including index.html)
app.use(express.static('.'));

// Serve index.html on root path
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log('Open your browser and navigate to the URL above');
});
