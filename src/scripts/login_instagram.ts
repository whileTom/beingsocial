
import { IgApiClient } from 'instagram-private-api';
import dotenv from 'dotenv';
import inquirer from 'inquirer';
import fs from 'fs';
import path from 'path';

dotenv.config();

const SESSION_FILE = path.join(__dirname, '..', '..', 'data', 'instagram_session.json');

async function login() {
    const ig = new IgApiClient();
    const username = process.env.INSTAGRAM_USERNAME;
    const password = process.env.INSTAGRAM_PASSWORD;

    if (!username || !password) {
        console.error('❌ Missing INSTAGRAM_USERNAME or INSTAGRAM_PASSWORD in .env');
        return;
    }

    ig.state.generateDevice(username);

    // Try to load existing session
    if (fs.existsSync(SESSION_FILE)) {
        console.log('📂 Loading saved session...');
        const savedSession = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf-8'));
        await ig.state.deserialize(savedSession);
    }

    try {
        console.log(`📸 Logging in as ${username}...`);

        // Simulating some pre-login behavior
        await ig.simulate.preLoginFlow();

        const loggedInUser = await ig.account.login(username, password);
        console.log(`✅ Logged in as ${loggedInUser.username}`);

        // Save session
        saveSession(ig);

    } catch (error: any) {
        console.error('❌ Login failed:', error.message);

        if (error.name === 'IgCheckpointError') {
            console.log('🔒 Checkpoint detected! Resetting logic...');
            await ig.challenge.auto(true); // Request code via SMS/Email

            const { code } = await inquirer.prompt([
                {
                    type: 'input',
                    name: 'code',
                    message: 'Enter the 6-digit code sent to your phone/email:',
                },
            ]);

            console.log(`🔑 Submitting code: ${code}`);

            try {
                const response = await ig.challenge.sendSecurityCode(code);
                console.log('✅ Challenge Verified!');
                saveSession(ig);
            } catch (err: any) {
                console.error('❌ Failed to verify code:', err.message);
            }
        } else if (error.name === 'IgLoginTwoFactorRequiredError') {
            const { twoFactorIdentifier } = error.response.body.two_factor_info;
            console.log('🔐 2FA Required!');

            const { code } = await inquirer.prompt([
                {
                    type: 'input',
                    name: 'code',
                    message: 'Enter the 2FA code from your authenticator app:',
                },
            ]);

            try {
                // Determine verification method (defaulting to TOTP)
                const method = '0'; // 1 for SMS, 0 for TOTP (Authentication App)
                await ig.account.twoFactorLogin({
                    username,
                    verificationCode: code,
                    twoFactorIdentifier,
                    verificationMethod: method,
                    trustThisDevice: '1',
                });
                console.log('✅ 2FA Verified!');
                saveSession(ig);
            } catch (err: any) {
                console.error('❌ Failed to verify 2FA:', err.message);
            }
        } else if (error.name === 'IgLoginBadPasswordError') {
            console.log('⚠️ Instagram returned "Bad Password".');
            if (error.response) {
                console.log('📉 Raw Error Body:', JSON.stringify(error.response.body, null, 2));
            }
            console.log('🔄 Attempting to force manual challenge...');

            try {
                await ig.challenge.auto(true);
                console.log('✅ Challenge triggered!');

                const { code } = await inquirer.prompt([
                    {
                        type: 'input',
                        name: 'code',
                        message: 'Enter the 6-digit code sent to your phone/email:',
                    },
                ]);

                await ig.challenge.sendSecurityCode(code);
                console.log('✅ Challenge Verified!');
                saveSession(ig);
                return;
            } catch (challengeError: any) {
                console.error('❌ Failed to auto-resolve challenge:', challengeError.message);
                console.log('👉 Please log in manually on your phone, approve "Was this you?", and try again.');
            }
        }
    }
}

async function saveSession(ig: IgApiClient) {
    const serialized = await ig.state.serialize();
    delete serialized.constants; // Optional cleanup
    fs.writeFileSync(SESSION_FILE, JSON.stringify(serialized));
    console.log(`💾 Session saved to ${SESSION_FILE}`);
}

login();
