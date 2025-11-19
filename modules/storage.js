const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const tempDir = path.join(__dirname, '../temp');

async function ensureTempDir() {
    try {
        await fs.accessSync(tempDir);
    } catch (error) {
        if (error.code === 'ENOENT') {
            await fs.mkdirSync(tempDir, { recursive: true });
        } else {
            throw error;
        }
    }
}

async function cleanupTempFiles() {
    try {
        const files = await fs.readdirSync(tempDir);
        for (const file of files) {
            await fs.unlinkSync(path.join(tempDir, file));
        }
    } catch (error) {
        console.error(`Error cleaning up temp files: ${error.message}`);
    }
}

async function saveFullText(link, fullText) {
    return new Promise((resolve, reject) => {
        try {
            ensureTempDir();
            const fileName = encodeURIComponent(link) + '.txt';
            let filePath = path.join(tempDir, fileName);

            if (filePath.length > 260) {
                const hash = crypto.createHash('md5').update(link).digest('hex');
                const shortenedFileName = hash + '.txt';
                filePath = path.join(tempDir, shortenedFileName);
            }

            fs.writeFileSync(filePath, fullText, 'utf8');
            resolve();
        } catch (error) {
            console.error(`Error saving full text for ${link}: ${error.message}`);
            reject(error);
        }
    });
}

async function getFullText(link) {
    return new Promise((resolve, reject) => {
        const fileName = encodeURIComponent(link) + '.txt';
        let filePath = path.join(tempDir, fileName);

        try {
            if (filePath.length > 260) {
                const hash = crypto.createHash('md5').update(link).digest('hex');
                const shortenedFileName = hash + '.txt';
                filePath = path.join(tempDir, shortenedFileName);
            }

            if (fs.existsSync(filePath)) {
                const content = fs.readFileSync(filePath, 'utf8');
                resolve(content);
            } else {
                resolve(null);
            }
        } catch (error) {
            console.error(`Error reading full text for ${link}: ${error.message}`);
            resolve(null);
        }
    });
}

module.exports = {
    ensureTempDir,
    cleanupTempFiles,
    saveFullText,
    getFullText,
    tempDir
};
