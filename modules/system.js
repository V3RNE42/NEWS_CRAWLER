const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { saveLog } = require('./logger');
const { SAFE_TO_REBOOT_FLAG, SAFE_REBOOT_MESSAGE } = require('./constants');

const safePath = path.join(__dirname, '../', SAFE_TO_REBOOT_FLAG);

function checkSafeAndReboot(reason) {
    console.log(`Checking if it's safe to reboot due to: ${reason}`);
    fs.readFile(safePath, 'utf8', (err, data) => {
        if (err) {
            console.error(`Error reading safe-to-reboot flag: ${err}`);
            console.log('Skipping reboot due to error reading flag.');
            process.exit(1);
        } else if (data.trim() === SAFE_REBOOT_MESSAGE) {
            if (reason.message.includes('FATAL') ||
                reason.code == 'CRITICAL_ERROR' ||
                reason instanceof TypeError) {
                console.log('Safe to reboot flag is set. Initiating reboot...');
                saveLog(reason);
                initiateReboot(reason);
            } else {
                console.log('That was NOT fatal. Exiting without reboot.');
                process.exit(1);
            }
        } else {
            console.log('Not safe to reboot. Exiting without reboot.');
            process.exit(1);
        }
    });
}

function initiateReboot(reason) {
    console.log(`Initiating system reboot due to: ${reason}`);
    if (process.platform === "win32") {
        exec('shutdown /r /t 10', (error, stdout, stderr) => {
            if (error) {
                console.error(`Reboot failed: ${error}`);
                return;
            }
            console.log('System will reboot in 10 seconds.');
        });
    } else {
        exec('sudo /sbin/shutdown -r now', (error, stdout, stderr) => {
            if (error) {
                console.error(`Reboot failed: ${error}`);
                return;
            }
            console.log('System is rebooting now.');
        });
    }
    setTimeout(() => process.exit(1), 5000);
}

const forceGarbageCollection = () => {
    if (global.gc) {
        global.gc();
        console.log('Forced garbage collection completed');
    } else {
        console.log('Garbage collection is not exposed. Use --expose-gc when launching node to enable forced garbage collection.');
    }
};

module.exports = {
    checkSafeAndReboot,
    initiateReboot,
    forceGarbageCollection,
    safePath
};
