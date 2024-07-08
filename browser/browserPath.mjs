import { exec }  from 'child_process';
import os  from 'os';
import fs  from 'fs';
import puppeteer  from 'puppeteer-core';

const getChromiumPaths = () => {
    return new Promise((resolve, reject) => {
        const platform = os.platform();
        let command;

        command = 'npx puppeteer browsers install chrome';
        exec(command, (error, stdout, stderr) => {
            if (error) {
                return reject(new Error(`Command failed: ${command}\n${stderr}`));
            }
        });

        switch (platform) {
            case 'win32':
                const winPaths = [
                    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
                    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
                    'C:\\Program Files\\Chromium\\Application\\chrome.exe',
                    'C:\\Program Files (x86)\\Chromium\\Application\\chrome.exe'
                ];
                resolve(winPaths);
                command = 'where chrome || where chromium || where chrome.exe || where chromium.exe';
                exec(command, (error, stdout, stderr) => {
                    if (!error) {
                        const paths = stdout.split('\n').filter(Boolean);
                        resolve(paths);
                    }
                });
                break;

            case 'darwin':
                command = 'mdfind "kMDItemDisplayName == \'Google Chrome\' && kMDItemKind == \'Application\'"';
                exec(command, (error, stdout, stderr) => {
                    if (error) {
                        return reject(new Error(`Command failed: ${command}\n${stderr}`));
                    }
                    const paths = stdout.split('\n').filter(Boolean);
                    resolve(paths);
                });
                break;

            case 'linux':
                command = 'dpkg -L chromium-browser chromium google-chrome-stable 2>/dev/null | grep -E "(chromium|chrome)$"';
                exec(command, (error, stdout, stderr) => {
                    const paths = stdout.split('\n').filter(Boolean);

                    // Add common paths manually
                    const commonPaths = [
                        '/usr/bin/chromium-browser',
                        '/usr/bin/chromium',
                        '/usr/bin/google-chrome',
                        '/snap/bin/chromium',
                        '/usr/lib/chromium-browser/chromium-browser'
                    ];

                    resolve([...paths, ...commonPaths]);
                });
                break;

            default:
                reject(new Error('Unsupported platform: ' + platform));
        }
    });
};

/**Finds a valid Chromium/Chrome executable path from a list of paths
 * @param {Array<string>} paths - The list of paths to search for a valid executable.
 * @return {Promise<string>} A Promise that resolves to the valid executable path, or rejects with an error.     */
async function findValidChromiumPath() {
    let paths = await getChromiumPaths();
    for (const path of paths) {
        if (fs.existsSync(path)) {
            try {
                const browser = await puppeteer.launch({
                    executablePath: path,
                    headless: true
                });
                await browser.close();
                return path;
            } catch (error) {
                continue;
            }
        }
    }
    throw new Error('No valid Chromium/Chrome executable found');
};

export {
    findValidChromiumPath
}