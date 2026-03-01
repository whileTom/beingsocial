
import puppeteer from 'puppeteer-core';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import inquirer from 'inquirer';

dotenv.config();

const COOKIES_FILE = path.join(__dirname, '..', '..', 'data', 'instagram_cookies.json');

// Find Chrome path for Windows
// Common paths for Chrome or Edge
const CHROME_PATHS = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];

function findBrowserPath(): string {
    for (const p of CHROME_PATHS) {
        if (fs.existsSync(p)) return p;
    }
    throw new Error('Chrome or Edge not found. Please install Chrome or specify path manually.');
}

async function login() {
    const executablePath = findBrowserPath();
    console.log(`🚀 Launching browser: ${executablePath}`);

    const browser = await puppeteer.launch({
        executablePath,
        headless: false, // Show the UI
        defaultViewport: null,
        args: ['--start-maximized', '--no-sandbox']
    });

    const page = await browser.newPage();
    await page.goto('https://www.instagram.com/accounts/login/', { waitUntil: 'networkidle2' });

    console.log('👉 Please log in manually in the opened browser window.');
    console.log('👉 Handle any 2FA or "Was this you?" prompts there.');

    // Wait for user confirmation
    await inquirer.prompt([
        {
            type: 'input',
            name: 'confirm',
            message: 'Press ENTER once you are fully logged in and can see your feed:',
        },
    ]);

    console.log('🍪 Capturing cookies...');
    const cookies = await page.cookies();

    // Save cookies (minimal set)
    const sessionCookies = cookies.filter(c =>
        ['sessionid', 'ds_user_id', 'csrftoken', 'rur', 'mid'].includes(c.name)
    );

    fs.writeFileSync(COOKIES_FILE, JSON.stringify(cookies, null, 2)); // Save ALL cookies to be safe
    console.log(`✅ Saved ${cookies.length} cookies to ${COOKIES_FILE}`);

    await browser.close();
}

login().catch(console.error);
