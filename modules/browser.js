const puppeteer = require('puppeteer');
const axios = require('axios');
const { RateLimiter } = require('limiter');
const config = require('../config.json');
const { findValidChromiumPath } = require('../browser/browserPath');
const { STRING_PLACEHOLDER, EMPTY_STRING } = require('./constants');
const { removeWeirdCharactersFromUrl, normalizeUrl, denormalizeUrl, sleep, LightweightError } = require('./utils');
const { state } = require('./state');

const INITIAL_DELAY = 500;
const MAX_RETRIES_PER_FETCH = 3;
let BROWSER_PATH;

const rateLimiter = new RateLimiter({
    tokensPerInterval: 1,
    interval: 'second',
    fireImmediately: true
});

async function assignBrowserPath() {
    BROWSER_PATH = config.browser.path === STRING_PLACEHOLDER
        ? await findValidChromiumPath()
        : config.browser.path;
}

async function getProxiedContent(link) {
    try {
        console.log(`Article may be behind a PayWall :-(\nLet's try to access via proxy for ${link} ...`);
        const browser = await puppeteer.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox'],
            executablePath: BROWSER_PATH,
            protocolTimeout: 120000
        });
        let page = await browser.newPage();
        await page.setDefaultNavigationTimeout(120000);

        await page.goto('https://www.removepaywall.com/', { waitUntil: 'domcontentloaded' });
        await page.type('input#simple-search', link);
        await page.click('#__next > div > section > div > header > div > div:nth-child(4) > form > button');
        await page.waitForNavigation({ waitUntil: 'domcontentloaded' });

        const content = await page.evaluate(() => document.body.innerText);
        const retrievedUrl = page.url();

        await browser.close();
        return { url: retrievedUrl, content: content };
    } catch (error) {
        console.error('Error in fetching proxied content:', error);
        return { url: EMPTY_STRING, content: EMPTY_STRING };
    }
}

async function fetchWithRetry(url, retries = 0, initialDelay = INITIAL_DELAY, triedBoth = false) {
    if (state.stopFlag) {
        throw new LightweightError('Crawl stopped');
    }

    let urlWithoutSlash = normalizeUrl(url);
    let urlWithSlash = denormalizeUrl(url);

    let urlToFetch = triedBoth ? url : (retries % 2 === 0 ? urlWithoutSlash : urlWithSlash);

    try {
        const randomDelay = Math.floor(Math.random() * initialDelay);
        await sleep(randomDelay);
        await rateLimiter.removeTokens(1);
        const response = await axios.get(urlToFetch, {
            headers: {
                'User-Agent': 'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36 Edg/91.0.864.59'
            },
            timeout: 15000
        });
        return response.data;
    } catch (error) {
        if (!triedBoth) {
            console.log(`Attempt failed for ${urlToFetch}. Trying alternate URL...`);
            return fetchWithRetry(urlToFetch === urlWithoutSlash ? urlWithSlash : urlWithoutSlash, retries, initialDelay, true);
        }

        if (retries >= MAX_RETRIES_PER_FETCH - 1) {
            throw new LightweightError(`Failed to fetch ${url} after ${MAX_RETRIES_PER_FETCH} retries: ${error.message}`);
        }

        const delay = initialDelay * Math.pow(3, retries);
        console.log(`Attempt ${retries + 1} failed for ${url}. Retrying in ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
        return fetchWithRetry(url, retries + 1, delay, false);
    }
}

async function fetchForRSS(url, retries = 0, initialDelay = 500) {
    const MAX_RETRIES = 5;
    const normalizedUrl = normalizeUrl(removeWeirdCharactersFromUrl(url));

    await sleep(Math.floor(initialDelay * Math.random()));

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
            const response = await axios.get(normalizedUrl, {
                headers: {
                    'User-Agent': 'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36 Edg/91.0.864.59'
                },
                timeout: 30000,
                maxRedirects: 5
            });

            return {
                data: response.data,
                headers: response.headers
            };
        } catch (error) {
            console.error(`Attempt ${attempt + 1} failed for ${normalizedUrl}. Error: ${error.message}`);

            if (error.response && error.response.status === 429) {
                const retryAfter = error.response.headers['retry-after'];
                const delay = retryAfter ? parseInt(retryAfter) * 1000 : 60000;
                console.log(`Rate limited. Waiting for ${delay / 1000} seconds before retry...`);
                await new Promise(resolve => setTimeout(resolve, delay));
                continue;
            }

            if (attempt === MAX_RETRIES || !error.response || error.response.status === 404) {
                throw new Error(`Failed to fetch ${normalizedUrl} after ${attempt + 1} attempts: ${error.message}`);
            }

            const delay = initialDelay * Math.pow(2, attempt);
            console.log(`Retrying in ${delay}ms...`);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
}

async function fetchTextWithRetry(url) {
    const response = await fetchWithRetry(removeWeirdCharactersFromUrl(url));
    if (typeof response === 'string') {
        return response;
    } else if (response && typeof response.data === 'string') {
        return response.data;
    } else {
        throw new Error('Unexpected response format');
    }
}

module.exports = {
    assignBrowserPath,
    getProxiedContent,
    fetchWithRetry,
    fetchForRSS,
    fetchTextWithRetry
};
