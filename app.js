const fs = require('fs');
const express = require('express');
const bodyParser = require('body-parser');
const session = require('express-session');
const bcrypt = require('bcrypt');
const multer = require('multer');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const ExcelJS = require('exceljs');

const app = express();
const dbPath = path.join(__dirname, 'academic_journal.db');
const db = new sqlite3.Database(dbPath);

// Middleware setup
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static('public'));
app.set('view engine', 'ejs');

app.use(session({
    secret: 'secretKey',
    resave: false,
    saveUninitialized: false
}));

// File upload setup with multer
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, 'uploads/');
    },
    filename: function (req, file, cb) {
        cb(null, Date.now() + '-' + file.originalname);
    }
});
const upload = multer({ storage: storage });

// Ensure uploads directory exists
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir);
}

// Route for the home page
app.get('/', (req, res) => {
    res.render('index', { user: req.session.user || null });
});

// Registration route
app.get('/register', (req, res) => {
    res.render('register', { user: req.session.user || null });
});

app.post('/register', async (req, res) => {
    const { username, password, role, email } = req.body;
    if (!username || !password || !role || !email) {
        return res.status(400).send('All fields are required');
    }

    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        db.run(
            'INSERT INTO Users (username, password, role, email) VALUES (?, ?, ?, ?)',
            [username, hashedPassword, role, email],
            function (err) {
                if (err) {
                    return res.status(500).send('Error registering user');
                }
                res.redirect('/login');
            }
        );
    } catch (error) {
        res.status(500).send('Internal Server Error');
    }
});

// Login route
app.get('/login', (req, res) => {
    res.render('login', { user: req.session.user || null });
});

app.post('/login', (req, res) => {
    const { username, password } = req.body;
    db.get('SELECT * FROM Users WHERE username = ?', [username], async (err, user) => {
        if (err || !user || !(await bcrypt.compare(password, user.password))) {
            return res.status(401).send('Invalid credentials');
        }
        req.session.user = user;
        if (user.role === 'author') {
            res.redirect('/author-dashboard');
        } else if (user.role === 'reviewer') {
            res.redirect('/reviewer-dashboard');
        } else {
            res.redirect('/editor-dashboard');
        }
    });
});

// Logout route
app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/login');
});

// Middleware to check if the user is logged in
function isAuthenticated(req, res, next) {
    if (req.session.user) {
        return next();
    }
    res.redirect('/login');
}

// Author Dashboard Route - View Submitted Manuscripts
app.get('/author-dashboard', isAuthenticated, (req, res) => {
    const userId = req.session.user.id;
    db.all('SELECT * FROM Manuscripts WHERE author_id = ?', [userId], (err, rows) => {
        if (err) {
            return res.status(500).send('Error retrieving submitted manuscripts');
        }
        res.render('author-dashboard', { manuscripts: rows, user: req.session.user });
    });
});

// Manuscript Submission Route
app.get('/submit-manuscript', isAuthenticated, (req, res) => {
    if (req.session.user.role !== 'author') {
        return res.status(403).send('Forbidden');
    }
    res.render('submit-manuscript', { user: req.session.user });
});

app.post('/submit-manuscript', isAuthenticated, upload.single('manuscript'), (req, res) => {
    if (req.session.user.role !== 'author') {
        return res.status(403).send('Forbidden');
    }
    const { title, abstract } = req.body;
    const filePath = req.file.path;
    const authorId = req.session.user.id;
    const submissionDate = new Date().toISOString();

    db.run('INSERT INTO Manuscripts (title, abstract, file_path, author_id, submission_date) VALUES (?, ?, ?, ?, ?)',
        [title, abstract, filePath, authorId, submissionDate],
        function (err) {
            if (err) {
                return res.status(500).send('Error submitting manuscript');
            }
            res.redirect('/author-dashboard');
        }
    );
});

// Reviewer Dashboard Route - View Assigned Manuscripts and Reviews
app.get('/reviewer-dashboard', isAuthenticated, (req, res) => {
    if (req.session.user.role !== 'reviewer') {
        return res.status(403).send('Forbidden');
    }

    db.all('SELECT * FROM Manuscripts WHERE status = "submitted"', [], (err, manuscripts) => {
        if (err) {
            return res.status(500).send('Error retrieving manuscripts');
        }

        // Fetch reviews for each manuscript
        const manuscriptsWithReviews = [];
        let counter = 0;

        manuscripts.forEach(manuscript => {
            db.all('SELECT * FROM Reviews WHERE manuscript_id = ?', [manuscript.id], (err, reviews) => {
                if (err) {
                    return res.status(500).send('Error retrieving reviews');
                }

                manuscript.reviews = reviews;
                manuscriptsWithReviews.push(manuscript);
                counter++;

                // Render after processing all manuscripts
                if (counter === manuscripts.length) {
                    res.render('reviewer-dashboard', { manuscripts: manuscriptsWithReviews, user: req.session.user });
                }
            });
        });

        if (manuscripts.length === 0) {
            res.render('reviewer-dashboard', { manuscripts: [], user: req.session.user });
        }
    });
});

// Submit Review Route
app.post('/submit-review/:manuscriptId', isAuthenticated, (req, res) => {
    if (req.session.user.role !== 'reviewer') {
        return res.status(403).send('Forbidden');
    }
    const manuscriptId = req.params.manuscriptId;
    const reviewerId = req.session.user.id;
    const { feedback, decision } = req.body;
    const reviewDate = new Date().toISOString();

    db.run('INSERT INTO Reviews (manuscript_id, reviewer_id, feedback, decision, review_date) VALUES (?, ?, ?, ?, ?)',
        [manuscriptId, reviewerId, feedback, decision, reviewDate],
        function (err) {
            if (err) {
                return res.status(500).send('Error submitting review');
            }
            db.run('UPDATE Manuscripts SET status = ? WHERE id = ?', [decision, manuscriptId], (err) => {
                if (err) {
                    return res.status(500).send('Error updating manuscript status');
                }
                res.redirect('/reviewer-dashboard');
            });
        }
    );
});

// Admin Panel Route - Manage Manuscripts and Users
app.get('/editor-dashboard', isAuthenticated, (req, res) => {
    if (req.session.user.role !== 'editor') {
        return res.status(403).send('Forbidden');
    }
    db.all('SELECT * FROM Manuscripts', [], (err, manuscripts) => {
        if (err) {
            return res.status(500).send('Error retrieving manuscripts');
        }
        db.all('SELECT * FROM Users WHERE role = "reviewer"', [], (err, reviewers) => {
            if (err) {
                return res.status(500).send('Error retrieving reviewers');
            }
            res.render('editor-dashboard', { manuscripts, reviewers, user: req.session.user });
        });
    });
});

// Assign Reviewer Route
app.post('/assign-reviewer', isAuthenticated, (req, res) => {
    if (req.session.user.role !== 'editor') {
        return res.status(403).send('Forbidden');
    }
    const { manuscriptId, reviewerId } = req.body;
    db.run('UPDATE Manuscripts SET status = "assigned", editor_id = ? WHERE id = ?',
        [req.session.user.id, manuscriptId], function (err) {
            if (err) {
                return res.status(500).send('Error assigning reviewer');
            }
            res.redirect('/editor-dashboard');
        });
});

// View Reviews Route
app.get('/view-reviews/:manuscriptId', isAuthenticated, (req, res) => {
    const manuscriptId = req.params.manuscriptId;

    db.all('SELECT * FROM Reviews WHERE manuscript_id = ?', [manuscriptId], (err, reviews) => {
        if (err) {
            return res.status(500).send('Error retrieving reviews');
        }
        db.get('SELECT title FROM Manuscripts WHERE id = ?', [manuscriptId], (err, manuscript) => {
            if (err || !manuscript) {
                return res.status(500).send('Error retrieving manuscript information');
            }
            res.render('view-reviews', { reviews: reviews, manuscript: manuscript, user: req.session.user });
        });
    });
});

// Submit Review Form Route
app.get('/submit-review/:manuscriptId', isAuthenticated, (req, res) => {
    const manuscriptId = req.params.manuscriptId;

    db.get('SELECT * FROM Manuscripts WHERE id = ?', [manuscriptId], (err, manuscript) => {
        if (err || !manuscript) {
            return res.status(500).send('Error retrieving manuscript information');
        }
        res.render('submit-review', { manuscript: manuscript, user: req.session.user });
    });
});

// Route to handle file download
app.get('/download/:id', (req, res) => {
    const manuscriptId = req.params.id;
    
    db.get('SELECT file_path FROM Manuscripts WHERE id = ?', [manuscriptId], (err, row) => {
        if (err) {
            return res.status(500).send('Error retrieving the file.');
        }

        if (!row) {
            return res.status(404).send('File not found.');
        }

        const filePath = path.join(__dirname, row.file_path);
        res.download(filePath, (err) => {
            if (err) {
                console.error('Error downloading the file:', err);
                res.status(500).send('Error downloading the file.');
            }
        });
    });
});

// Excel Export Route
app.get('/export-excel', isAuthenticated, (req, res) => {
    if (req.session.user.role !== 'editor') {
        return res.status(403).send('Forbidden');
    }

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Manuscripts');

    sheet.columns = [
        { header: 'Paper ID', key: 'id' },
        { header: 'Title', key: 'title' },
        { header: 'Author', key: 'author_id' },
        { header: 'Editor', key: 'editor_id' },
        { header: 'Status', key: 'status' },
        { header: 'Submission Date', key: 'submission_date' }
    ];

    db.all('SELECT * FROM Manuscripts', [], (err, rows) => {
        if (err) {
            return res.status(500).send('Error exporting data');
        }
        rows.forEach(row => {
            sheet.addRow(row);
        });

        res.setHeader('Content-Disposition', 'attachment; filename="manuscripts.xlsx"');
        workbook.xlsx.write(res).then(() => {
            res.end();
        });
    });
});

// Reader Dashboard Route - No Login Required
app.get('/reader-dashboard', (req, res) => {
    // Fetch only approved manuscripts
    db.all('SELECT * FROM Manuscripts WHERE status = "accepted"', [], (err, manuscripts) => {
        if (err) {
            return res.status(500).send('Error retrieving manuscripts.');
        }
        // Pass user as null since readers don't need to be logged in
        res.render('reader-dashboard', { manuscripts, user: null });
    });
});


// Server setup
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
