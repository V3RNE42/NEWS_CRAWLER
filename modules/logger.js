const fs = require('fs');
const path = require('path');
const util = require('util');
const { todayDate } = require('./utils');

let consoleLog = '';

const getTimestamp = () => {
    return new Date().toISOString();
}

const resetLog = () => {
    consoleLog = '';
}

const saveLog = (reason = 'unknown') => {
    const logDir = path.join(__dirname, '../logs');
    if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir);
    }
    const logFile = path.join(logDir, `log_${todayDate().replace(/\//g, '-')}_${reason}.txt`);
    fs.writeFileSync(logFile, consoleLog);
}

const logToConsoleAndMemory = (type, args) => {
    const timestamp = getTimestamp();
    const message = args.map(arg => typeof arg === 'object' ? util.inspect(arg) : arg).join(' ');
    const logMessage = `[${timestamp}] [${type.toUpperCase()}] ${message}\n`;

    process.stdout.write(logMessage);
    consoleLog += logMessage;
}

const initializeLogger = () => {
    const originalConsole = {
        log: console.log,
        error: console.error
    };

    console.log = (...args) => {
        logToConsoleAndMemory('log', args);
    };

    console.error = (...args) => {
        logToConsoleAndMemory('error', args);
    };

    return originalConsole;
}

function clearConsole() {
    process.stdout.write('\u001b[3J');
    process.stdout.write('\u001b[H');
    process.stdout.write('\u001b[2J');

    if (console.clear) {
        console.clear();
    }

    if (process.platform === 'win32') {
        try {
            const { execSync } = require('child_process');
            execSync('cls', { stdio: 'inherit' });
        } catch (e) {
            console.log('\n'.repeat(process.stdout.rows));
        }
    } else {
        try {
            const { execSync } = require('child_process');
            execSync('clear', { stdio: 'inherit' });
        } catch (e) {
            console.log('\n'.repeat(process.stdout.rows));
        }
    }
}

module.exports = {
    getTimestamp,
    resetLog,
    saveLog,
    logToConsoleAndMemory,
    initializeLogger,
    clearConsole
};
