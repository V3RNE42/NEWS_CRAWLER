//MODULES AND IMPORTS
const nodemailer = require("nodemailer");
const fs = require("fs");
const path = require("path");
const cheerio = require('cheerio');
const axios = require("axios");
const { OpenAI } = require("openai");
const puppeteer = require('puppeteer');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const { RateLimiter } = require('limiter');
const os = require('os');
const { parse, differenceInHours } = require('date-fns');
const { es, enUS } = require('date-fns/locale');
let { terms, websites } = require("./terminos");
const config = require("./config.json");
const { getMainTopics, sanitizeHtml } = require("./text_analysis/topics_extractor");
const { coveringSameNews } = require("./text_analysis/natural_processing");
const { findValidChromiumPath } = require("./browser/browserPath");

//IMPORTANT CONSTANTS AND SETTINGS
const openai = new OpenAI({ apiKey: config.openai.api_key });
const LANGUAGE = config.text_analysis.language;
const SENSITIVITY = config.text_analysis.topic_sensitivity;
const MAX_TOKENS_PER_CALL = config.openai.max_tokens_per_call;
const SIMILARITY_THRESHOLD = config.text_analysis.max_similarity;
const MAX_RETRIES_PER_FETCH = 3; //to be managed by user configuration
const INITIAL_DEALY = 500; //to be managed by user configuration
const MINUTES_TO_CLOSE = 10 * 60000;
let FALSE_ALARM = false;
let BROWSER_PATH;

const STRING_PLACEHOLDER = "placeholder";
const FAILED_SUMMARY_MSSG = "No se pudo generar un resumen";
const EMPTY_STRING = "";
const CRAWLED_RESULTS_JSON = "crawled_results.json";
const CRAWL_COMPLETE_FLAG = "crawl_complete.flag";
const CRAWL_COMPLETE_TEXT = "Crawling completed!";
const MOST_COMMON_TERM = "Most_Common_Term";

let addedLinks = new Set();
let workers = [];
terms = terms.map((term) => term.toLowerCase());


const parseTime = (timeStr) => {
    // Regular expression to match HH:MM format
    const timeRegex = /^([0-1]?[0-9]|2[0-3]):([0-5][0-9])$/;

    if (!timeRegex.test(timeStr)) {
        throw new Error('Invalid time format. Please use HH:MM (24-hour format).');
    }

    const [hourStr, minuteStr] = timeStr.split(":");
    const hour = parseInt(hourStr, 10);
    const minute = parseInt(minuteStr, 10);

    if (isNaN(hour) || isNaN(minute)) {
        throw new Error('Invalid time: hour or minute is not a number');
    }

    const now = new Date();
    const result = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute);

    // Subtract MINUTES_TO_CLOSE
    result.setMinutes(result.getMinutes() - Math.floor(MINUTES_TO_CLOSE / 60000));

    // If the resulting time is earlier than now, set it to tomorrow
    if (result <= now) {
        result.setDate(result.getDate() + 1);
    }

    return result;
};

let globalStopFlag = false;

//FUNCTIONS
/** Assigns a valid browser path to the BROWSER_PATH variable based on the configuration
 * @return {Promise<void>} A promise that resolves when the browser path is assigned.   */
async function assignBrowserPath() {
    BROWSER_PATH = config.browser.path === STRING_PLACEHOLDER
        ? await findValidChromiumPath()
        : config.browser.path;
}

const todayDate = () => new Date().toISOString().split("T")[0];

const sleep = async (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Extracts the text content of an article from a given URL.
 *
 * @param {string} url - The URL of the article.
 * @return {Promise<string>} A Promise that resolves to the extracted text content. */
async function extractArticleText(url) {
    try {
        const browser = await puppeteer.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox'],
            executablePath: BROWSER_PATH
        });
        const page = await browser.newPage();
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

        let articleText = await page.evaluate(() => {
            const mainSelectors = [
                'article', 'main', 'section', '.article-body',
                '.content', '.main-content', '.entry-content',
                '.post-content', '.story-body', '.news-article'
            ];

            let mainElement = null;
            for (let selector of mainSelectors) {
                mainElement = document.querySelector(selector);
                if (mainElement) break;
            }

            if (!mainElement) return '';

            return mainElement.innerText;
        });

        await browser.close();

        if (articleText === EMPTY_STRING) {
            const response = await fetch(url);
            const html = await response.text();
            const $ = cheerio.load(html);
            articleText = $.html();
        }

        return cleanText(articleText);
    } catch (error) {
        console.error(`Error extracting text from ${url}: ${error.message}`);
        return EMPTY_STRING;
    }
}

/** Cleans the given text by removing HTML tags and trimming whitespace
 * @param {string} text - The text to be cleaned.
 * @return {string} The cleaned text.     */
const cleanText = (text) => {
    text = sanitizeHtml(text, { allowedTags: [], allowedAttributes: [] });

    while (text.includes("\n\n")) {
        text = text.replace(/\n\n/g, '\n');
    }
    while (text.includes('  ')) {
        text = text.replace(/'  '/g, ' ');
    }

    while (text.includes("\t\t")) {
        text = text.replace(/\t\t/g, '\t');
    }

    return text.replace(/<[^>]*>/g, ' ').trim();
}

async function getChunkedOpenAIResponse(text, topic, maxTokens) {
    /** Generates a prompt for OpenAI to generate a summary of a specific part of a news article.
     * @param {string} news_content - The content of the news article.
     * @param {string} news_topic - The topic of the news article.
     * @param {number} current - The current part number of the news article being summarized.
     * @param {number} total - The total number of parts in the news article.
     * @return {string} The generated prompt for OpenAI.                                            */
    function getPrompt(news_content, news_topic, current, total) {
        return `Haz un resumen del siguiente fragmento que cubre la parte ${current} de ${total}` +
            `de la siguiente noticia:\n\n\n\n${news_content}\n\n\n\n` +
            `Ignora todo texto que no tenga que ver con el tema de la noticia: ${news_topic}`;
    }

    try {
        const chunks = splitTextIntoChunks(text);
        let respuesta = EMPTY_STRING;
        maxTokens = Math.floor(maxTokens / chunks.length);

        for (let i = 0; i < chunks.length; i++) {
            let content = getPrompt(chunks[i], topic, (i + 1), chunks.length);
            const response = await openai.chat.completions.create({
                model: "gpt-4",
                messages: [{ role: "user", content: content }],
                stream: true,
                max_tokens: maxTokens,
                temperature: 0.1,
                top_p: 0.1,
                frequency_penalty: 0.0,
                presence_penalty: 0.0,
            });

            for await (const chunkResponse of response) {
                respuesta += chunkResponse.choices[0]?.delta?.content || EMPTY_STRING;
            }
        }

        return respuesta;
    } catch (error) {
        console.error('Error in OpenAI response:', error);
        return EMPTY_STRING;
    }
}

/** Counts the tokens of a string
 *  @param {String} text The text whose tokens are to be counted
 *  @returns {number} The amount of tokens      */
const countTokens = (text) => text.trim().split(/\s+/).length;


/** Splits a text into chunks of a maximum number of tokens per call
 * @param {string} text - The text to be split into chunks.
 * @return {string[]} An array of chunks, each containing a maximum of MAX_TOKENS_PER_CALL tokens. */
function splitTextIntoChunks(text) {
    const tokens = text.split(/\s+/);
    const chunks = [];
    let currentChunk = EMPTY_STRING;

    for (const token of tokens) {
        if ((currentChunk + " " + token).length <= MAX_TOKENS_PER_CALL) {
            currentChunk += " " + token;
        } else {
            chunks.push(currentChunk.trim());
            currentChunk = token;
        }
    }

    if (currentChunk) {
        chunks.push(currentChunk.trim());
    }

    return chunks;
}

async function getNonChunkedOpenAIResponse(text, topic, maxTokens) {
    text = `Haz un resumen de la siguiente noticia:\n\n\n\n${text}\n\n\n\nIgnora todo texto que no tenga que ver con el tema de la noticia: ${topic}`;
    try {
        const response = await openai.chat.completions.create({
            model: "gpt-4",
            messages: [{ role: "user", content: text }],
            stream: true,
            max_tokens: maxTokens,
            temperature: 0.1,
            top_p: 0.1,
            frequency_penalty: 0.0,
            presence_penalty: 0.0,
        });
        let respuesta = EMPTY_STRING;
        for await (const chunk of response) {
            respuesta += chunk.choices[0]?.delta?.content || EMPTY_STRING;
        }
        return respuesta;
    } catch (error) {
        console.error('Error in OpenAI response:', error);
        return EMPTY_STRING;
    }
}


/**
 * Retrieves an OpenAI response for the given text and title.
 *
 * @param {string} text - The text to be summarized.
 * @param {string} topic - The topic of the news article.
 * @param {number} maxTokens - The maximum number of tokens allowed in the response.
 * @return {Promise<string>} A promise that resolves to the OpenAI response. If the text is empty or the topic is empty, an empty string is returned. If the number of tokens in the text exceeds the maximum allowed tokens per call, the function calls getChunkedOpenAIResponse to handle the text in chunks. 
 * Otherwise, it calls getNonChunkedOpenAIResponse to generate the response.  */
async function getOpenAIResponse(text, topic, maxTokens) {
    if (text == EMPTY_STRING || topic == EMPTY_STRING) {
        return EMPTY_STRING;
    }

    if (countTokens(text) >= MAX_TOKENS_PER_CALL) {
        return getChunkedOpenAIResponse(text, topic, maxTokens);
    }

    return getNonChunkedOpenAIResponse(text, topic, maxTokens);
}

/**
 * Retrieves the content of a webpage behind a paywall by using a proxy website.
 *
 * @param {string} link - The URL of the webpage.
 * @return {Promise<{url: string, content: string}>} A promise that resolves to an object containing the content of the webpage 
 * and the URL of the retrieved content if it is successfully retrieved, or an empty string if an error occurs.     */
async function getProxiedContent(link) {
    try {
        console.log(`Article may be behind a PayWall :-(\nLet's try to access via proxy for ${link} ...`);
        const browser = await puppeteer.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox'],
            executablePath: BROWSER_PATH
        });
        const page = await browser.newPage();
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

/**
 * Retrieves a summary of the text using OpenAI's GPT-4 model.
 *
 * @param {string} link - The URL of the webpage
 * @param {string} fullText - The text content of the news article
 * @param {number} numberOfLinks - The total number of links under the same TERM search
 * @param {string} topic - The topic of the news article
 * @return {Promise<{url: string, response: string}>} A promise that resolves to an object containing the summary of the text and the valid URL.  */
const summarizeText = async (link, fullText, numberOfLinks, topic) => {
    let text = fullText;
    let maxTokens = 150 + Math.ceil(300 / numberOfLinks);
    let response = EMPTY_STRING;
    let count = 0;
    let url = link;

    while ((response === EMPTY_STRING || countTokens(text) < 150) && count < 3) {
        if (count === 0) {
            response = await getOpenAIResponse(text, topic, maxTokens);
        } else if (count === 1) {
            ({ url, content: text } = await getProxiedContent(link));
            response = await getOpenAIResponse(text, topic, maxTokens);
        } else {
            response = FAILED_SUMMARY_MSSG;
            url = link;
        }
        count++;
    }

    return { url, response };
};


/**
 * Checks if a given date is recent.
 *
 * @param {string} dateText - The date to be checked.
 * @return {boolean} Returns true if the date is recent, false otherwise.   */
const isRecent = (dateText) => {
    if (!dateText) return false;

    const now = new Date();
    let date;

    // Handle relative time in both Spanish and English
    const relativeMatchES = dateText.match(/hace (\d+) (minutos?|horas?|días?|semanas?|meses?)/i);
    const relativeMatchEN = dateText.match(/(\d+) (minute|hour|day|week|month)s? ago/i);

    if (relativeMatchES || relativeMatchEN) {
        const [_, amount, unit] = relativeMatchES || relativeMatchEN;
        date = new Date(now);
        switch (unit.toLowerCase()) {
            case 'minuto':
            case 'minutos':
            case 'minute':
            case 'minutes':
                date.setMinutes(date.getMinutes() - parseInt(amount));
                break;
            case 'hora':
            case 'horas':
            case 'hour':
            case 'hours':
                date.setHours(date.getHours() - parseInt(amount));
                break;
            case 'día':
            case 'días':
            case 'day':
            case 'days':
                date.setDate(date.getDate() - parseInt(amount));
                break;
            case 'semana':
            case 'semanas':
            case 'week':
            case 'weeks':
                date.setDate(date.getDate() - (parseInt(amount) * 7));
                break;
            case 'mes':
            case 'meses':
            case 'month':
            case 'months':
                date.setMonth(date.getMonth() - parseInt(amount));
                break;
        }
    } else {
        // Handle absolute dates (including Spanish, English, and European formats)
        const formats = [
            'dd/MM/yyyy',
            'MM/dd/yyyy',
            'dd-MM-yyyy',
            'yyyy-MM-dd',
            'd MMMM yyyy',
            'MMMM d, yyyy',
            'd MMM yyyy',
            'MMM d, yyyy',
            "d 'de' MMMM 'de' yyyy",
            "d 'de' MMM'. de' yyyy"
        ];

        for (const format of formats) {
            // Try parsing with Spanish locale
            date = parse(dateText, format, new Date(), { locale: es });
            if (!isNaN(date)) break;

            // If Spanish fails, try English locale
            date = parse(dateText, format, new Date(), { locale: enUS });
            if (!isNaN(date)) break;
        }

        // If standard parsing fails, try custom parsing for abbreviated Spanish months
        if (isNaN(date)) {
            const spanishMonthAbbr = {
                'ene': 0, 'feb': 1, 'mar': 2, 'abr': 3, 'may': 4, 'jun': 5,
                'jul': 6, 'ago': 7, 'sept': 8, 'sep': 8, 'oct': 9, 'nov': 10, 'dic': 11
            };

            const match = dateText.match(/(\d{1,2}) de (\w{3,5})\. de (\d{4})/);
            if (match) {
                const [_, day, monthAbbr, year] = match;
                const month = spanishMonthAbbr[monthAbbr.toLowerCase()];
                if (month !== undefined) {
                    date = new Date(parseInt(year), month, parseInt(day));
                }
            }
        }

        if (isNaN(date)) {
            console.warn(`Could not parse date: ${dateText}`);
            return false;
        }
    }

    return differenceInHours(now, date) < 24;
};

async function fetchWithRetry(url, retries = 0, initialDelay = INITIAL_DEALY) {
    try {
        const randomDelay = Math.floor(Math.random() * initialDelay);
        await sleep(randomDelay);
        await rateLimiter.removeTokens(1);
        const response = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            },
            timeout: 15000
        });
        return response.data;
    } catch (error) {
        if (retries >= MAX_RETRIES_PER_FETCH) {
            throw new Error(`Failed to fetch ${url} after ${MAX_RETRIES_PER_FETCH} retries: ${error.message}`);
        }
        const delay = initialDelay * Math.pow(2, retries);
        console.log(`Attempt ${retries + 1} failed for ${url}. Retrying in ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
        return fetchWithRetry(url, retries + 1, delay);
    }
}

/**
 * Calculate the relevance score and find the most common term in the given text.
 *
 * @param {string} text - The text to analyze.
 * @return {object} An object containing the score and the most common term.    */
const relevanceScoreAndMaxCommonFoundTerm = (text) => {
    let score = 0, mostCommonTerm = EMPTY_STRING, maxCommonFoundTermCount = 0;

    for (const term of terms) {
        const regex = new RegExp("\\b" + term + "\\b", 'ig');
        const matches = text.match(regex) || [];
        const termCount = matches.length;
        if (termCount > 0) {
            score++;
            if (termCount > maxCommonFoundTermCount) {
                mostCommonTerm = term;
                maxCommonFoundTermCount = termCount;
            }
        }
    }

    return { score, mostCommonTerm };
};

const normalizeUrl = (url) => {
    let normalizedUrl = url.trim().toLowerCase();
    if (normalizedUrl.endsWith('/')) {
        normalizedUrl = normalizedUrl.slice(0, -1);
    }
    return normalizedUrl;
};

/**
 * Checks if the current time is close to the provided email end time.
 *
 * @param {Date} emailEndTime - The end time for the email
 * @return {boolean} Returns true if the current time is close to the email end time, false otherwise   */
function closeToEmailingTime(emailEndTime) {
    // Check if emailEndTime is a valid Date object
    if (!(emailEndTime instanceof Date) || isNaN(emailEndTime.getTime())) {
        console.error('Invalid emailEndTime provided to closeToEmailingTime');
        return false;
    }

    const now = new Date();
    const endWindow = new Date(emailEndTime.getTime() + MINUTES_TO_CLOSE);
    
    if (now >= emailEndTime && now < endWindow) {
        globalStopFlag = true;
        return true;
    }
    
    return false;
}

const rateLimiter = new RateLimiter({
    tokensPerInterval: 1,
    interval: 'second',
    fireImmediately: true
});

/** Creates a new worker thread with the specified workerData.
 * @param {Object} workerData - The data to pass to the worker.
 * @return {Promise<any>} A promise that resolves with the response from the worker */
function createWorker(workerData) {
    return new Promise((resolve, reject) => {
        const worker = new Worker(__filename, {
            workerData: {
                ...workerData,
                addedLinks: Array.from(addedLinks)
            }
        });
        workers.push(worker);

        let latestResult = null;

        worker.on('message', (message) => {
            if (message.type === 'result') {
                latestResult = message.result;
                resolve(latestResult);
            } else if (message.type === 'progress') {
                latestResult = message.result;
            } else if (message.type === 'addLinks') {
                message.links.forEach(link => addedLinks.add(link));
            }
        });

        worker.on('error', (error) => {
            console.error(`Worker error: ${error}`);
            reject(error);
        });

        worker.on('exit', (code) => {
            if (code !== 0) {
                console.error(`Worker stopped with exit code ${code}`);
            }
            workers = workers.filter(w => w !== worker);
            // Resolve with the latest result even if the worker exited unexpectedly
            resolve(latestResult);
        });

        // Ensure worker terminates after timeout
        setTimeout(() => {
            if (worker.threadId) {
                console.log(`Terminating worker ${worker.threadId} due to timeout`);
                worker.terminate();
            }
        }, workerData.cycleEndTime - Date.now());
    });
}

async function crawlWebsite(url, terms, workerAddedLinks) {
    let results = {};
    terms.forEach(term => results[term] = new Set());

    console.log(`Crawling ${url}...`);

    for (const term of terms) {
        if (globalStopFlag) {
            console.log("Stopping crawl due to global stop flag");
            return results;
        }

        try {
            const searchUrl = `https://www.bing.com/search?q=${encodeURIComponent(term)}+site:${encodeURIComponent(url)}&filters=ex1%3a"ez5"`;
            const html = await fetchWithRetry(searchUrl, MAX_RETRIES_PER_FETCH);
            const $ = cheerio.load(html);

            const articleElements = $("li.b_algo");

            for (let i = 0; i < articleElements.length && !globalStopFlag; i++) {
                const article = articleElements[i];
                const titleElement = $(article).find("h2");
                const linkElement = titleElement.find("a");
                const dateElement = $(article).find("span.news_dt");

                if (titleElement.length && linkElement.length && dateElement.length) {
                    const title = titleElement.text().trim();
                    const link = normalizeUrl(linkElement.attr("href"));
                    const dateText = dateElement.text().trim();

                    if (!isWebsiteValid(url, link)) continue;

                    try {
                        // Double-check if the link has been added
                        if (!workerAddedLinks.has(link)) {
                            if (isRecent(dateText)) {
                                let articleContent;
                                try {
                                    articleContent = await extractArticleText(link);
                                } catch (error) {
                                    console.error(`Error extracting text from ${link}: ${error.message}`);
                                    continue;
                                }

                                const { score, mostCommonTerm } = relevanceScoreAndMaxCommonFoundTerm(title + ' ' + articleContent);

                                if (score > 0) {
                                    workerAddedLinks.add(link);

                                    console.log(`Added article! - ${link}`);

                                    results[mostCommonTerm].add({
                                        title: title,
                                        link: link,
                                        summary: STRING_PLACEHOLDER,
                                        score: score,
                                        term: mostCommonTerm,
                                        fullText: articleContent,
                                        date: dateText
                                    });
                                }
                            }
                        }
                    } catch (error) {
                        console.error(`Error processing article ${link}: ${error.message}`);
                    }
                }
            }
        } catch (error) {
            console.error(`Error crawling ${url} for term ${term}: ${error.message}`);
            if (error.response) {
                console.error(`Status: ${error.response.status}, Data: ${JSON.stringify(error.response.data)}`);
            }
        }
    }

    Object.keys(results).forEach(term => {
        results[term] = Array.from(results[term]);
    });

    return results;
}

/**
 * Splits an array into a specified number of chunks.
 *
 * @param {Array} array - The array to be split into chunks.
 * @param {number} numChunks - The number of chunks to create.
 * @return {Array<Array>} An array of chunks, each containing a portion of the original array.  */
const chunkArray = (array, numChunks) => {
    let set = new Set(array);
    array = Array.from(set);
    const chunks = Array.from({ length: numChunks }, () => []);
    array.forEach((item, index) => {
        chunks[index % numChunks].push(item);
    });
    return chunks;
};

function isWebsiteValid(baseUrl, fullLink) {
    try {
        const baseHostname = new URL(baseUrl).hostname;
        const linkHostname = new URL(fullLink).hostname;

        if (baseHostname === linkHostname) {
            return false;
        }

        if (linkHostname.endsWith('.' + baseHostname) ||
            linkHostname.includes(baseHostname)) {
            return true;
        }

        return false;
    } catch (error) {
        console.warn(`Error comparing URLs: ${baseUrl} and ${fullLink}`);
        return false;
    }
}

function shuffleArray(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        const temp = array[i];
        array[i] = array[j];
        array[j] = temp;
    }
    return array;
}

/**
 * Crawls multiple websites for articles related to specified terms.
 *
 * @return {Promise<Object>} An object containing arrays of articles for each term. */
const crawlWebsites = async (cycleEndTime) => {
    console.log("Starting crawlWebsites function...");
    let allResults = {};
    for (const term of terms) allResults[term] = [];

    const shuffledWebsites = shuffleArray([...websites]);
    const maxConcurrentWorkers = os.cpus().length;
    const websiteChunks = chunkArray(shuffledWebsites, Math.ceil(shuffledWebsites.length / maxConcurrentWorkers));

    console.log(`Creating ${websiteChunks.length} worker(s)...`);
    const workerPromises = websiteChunks.map(websiteChunk =>
        createWorker({ websites: websiteChunk, terms, cycleEndTime })
    );

    console.log("All workers created. Starting crawl...");

    const timeoutPromise = new Promise(resolve =>
        setTimeout(() => {
            console.log("Timeout reached. Collecting results...");
            resolve('timeout');
        }, cycleEndTime.getTime() - Date.now())
    );

    const raceResult = await Promise.race([
        Promise.all(workerPromises),
        timeoutPromise
    ]);

    console.log(`Race completed. Result: ${raceResult === 'timeout' ? 'Timeout' : 'All workers finished'}`);

    console.log("Collecting results from all workers...");
    for (const workerPromise of workerPromises) {
        try {
            const workerResult = await workerPromise;
            if (workerResult && workerResult.articles) {
                for (const [term, articles] of Object.entries(workerResult.articles)) {
                    if (!allResults[term]) allResults[term] = [];
                    allResults[term].push(...articles);
                }
            }
        } catch (error) {
            console.error("Error retrieving worker results:", error);
        }
    }

    console.log("All results collected. Terminating workers...");
    for (const worker of workers) {
        worker.terminate();
    }
    workers = []; // Clear the workers array

    console.log("Crawling process completed.");
    return allResults;
};

/**
 * Removes redundant articles from the given results object.
 *
 * @param {Object} results - An object containing articles grouped by terms.
 * @return {Promise<void>} A promise that resolves when the redundant articles have been removed.   */
const removeRedundantArticles = async (results) => {
    for (const term of terms) {
        const articles = results[term];
        const uniqueArticles = [];
        const toRemove = new Set(); // Keep track of indices to remove
        for (let i = 0; i < articles.length; i++) {
            if (toRemove.has(i)) continue; // Skip if already marked for removal
            let unique = true;
            for (let j = 0; j < articles.length; j++) {
                if (i !== j && !toRemove.has(j)) {
                    const sameNews = await coveringSameNews(
                        articles[i].fullText,
                        articles[j].fullText,
                        LANGUAGE,
                        SIMILARITY_THRESHOLD
                    );
                    if (sameNews) {
                        unique = false;
                        if (articles[i].score < articles[j].score) {
                            toRemove.add(i);
                        } else {
                            toRemove.add(j);
                        }
                        break; // Stop inner loop as we found a duplicate
                    }
                }
            }
            if (unique) uniqueArticles.push(articles[i]);
        }
        const filteredArticles = articles.filter((_, index) => !toRemove.has(index));
        results[term] = filteredArticles;
    }

    return results;
}

/**
 * Arranges the articles from the given results object based on their terms.
 *
 * @param {Object} results - An object containing articles grouped by terms.
 * @return {Promise<Object>} - A promise that resolves to an object with articles reorganized by term */
async function removeIrrelevantArticles(results) {
    let reorganizedResults = {};

    // Initialize reorganizedResults with all terms from the original results
    for (const term of Object.keys(results)) {
        reorganizedResults[term] = [];
    }

    for (const [term, articles] of Object.entries(results)) {
        for (let article of articles) {
            if (article.fullText === EMPTY_STRING) {
                try {
                    article.fullText = await extractArticleText(article.link);
                } catch (error) {
                    console.error(`Error extracting text from ${article.link}: ${error.message}`);
                    continue; // Skip this article if text extraction fails
                }
            }

            let title = article.title;
            let textToAnalyze = title.concat(' ', article.fullText);

            let mainTopics = getMainTopics(textToAnalyze, LANGUAGE, SENSITIVITY);
            if (!mainTopics.some(topic => terms.includes(topic.toLowerCase())) && article.score === 1) {
                console.log(`Irrelevant article discarded: ${article.link}`);
                continue; // Skip this article if it's not relevant
            }

            reorganizedResults[term].push(article);
        }
    }

    return reorganizedResults;
}

/**
 * Saves the results to a JSON file.
 *
 * @param {Object} results - The results to be saved.
 * @return {Promise<boolean>} - A promise that resolves to a boolean indicating if the crawling is complete.    */
const saveResults = async (results, emailTime) => {
    console.log("Saving results...");
    const resultsPath = path.join(__dirname, CRAWLED_RESULTS_JSON);
    const flagPath = path.join(__dirname, CRAWL_COMPLETE_FLAG);
    let topArticles = [];
    let numTopArticles = 0;
    let mostCommonTerm = MOST_COMMON_TERM;
    let link = EMPTY_STRING, summary = EMPTY_STRING;

    const thisIsTheTime = closeToEmailingTime(emailTime);
    if (thisIsTheTime) {
        results = await removeIrrelevantArticles(results);
        results = await removeRedundantArticles(results);
        topArticles = extractTopArticles(results);
        numTopArticles = topArticles.length;
        for (let i = 0; i < numTopArticles; i++) {
            if (topArticles[i].summary === STRING_PLACEHOLDER ||
                topArticles[i].summary.includes(FAILED_SUMMARY_MSSG)) {
                ({ url: link, response: summary } = await summarizeText(
                    topArticles[i].link,
                    topArticles[i].fullText,
                    topArticles[i].term,
                    topArticles[i].title));
                topArticles[i].summary = summary;
                topArticles[i].link = link !== EMPTY_STRING ? link : topArticles[i].link;
            }
        }
        mostCommonTerm = mostCommonTerms(results);
    }

    const resultsWithTop = { results, topArticles, mostCommonTerm };

    fs.writeFileSync(resultsPath, JSON.stringify(resultsWithTop, null, 2));
    if (thisIsTheTime && !(FALSE_ALARM)) {
        fs.writeFileSync(flagPath, CRAWL_COMPLETE_TEXT);
        console.log(CRAWL_COMPLETE_TEXT)
    }

    return thisIsTheTime;
};

/**
 * Loads the previous results from the `crawled_results.json` file.
 * @return {Object} The previous results, or an empty object if the file doesn't exist or cannot be parsed. */
const loadPreviousResults = () => {
    console.log("Loading previous results...");
    const resultsPath = path.join(__dirname, CRAWLED_RESULTS_JSON);

    try {
        if (fs.existsSync(resultsPath)) {
            const fileContent = fs.readFileSync(resultsPath, 'utf8');
            const previousResults = JSON.parse(fileContent);

            if (!previousResults.results) {
                throw new Error('Invalid results structure');
            }

            for (const articles of Object.values(previousResults.results)) {
                articles.forEach(article => addedLinks.add(article.link));
            }

            return previousResults.results;
        } else {
            throw new Error('Results file does not exist');
        }
    } catch (err) {
        console.error("No previous results found. Loading new template...");
        let previousResults = {};
        terms.forEach(term => { previousResults[term] = []; });
        return previousResults;
    }
};

/**
 * Extracts the top articles from the given results.
 *
 * @param {Object} results - An object containing arrays of articles for each term.
 * @return {Array} An array of the top articles, with a maximum length determined by the square root of the total number of articles.   */
const extractTopArticles = (results) => {
    console.log("Extracting top articles...");
    let allArticles = [];
    for (let articles of Object.values(results)) {
        allArticles.push(...articles);
    }
    allArticles.sort((a, b) => b.score - a.score);

    let potentialReturn = allArticles.slice(0, Math.floor(Math.sqrt(allArticles.length)));

    let totalScore = 0;
    for (let i = 0; i < allArticles.length; i++) totalScore += allArticles[i].score;
    let threshold = Math.floor(totalScore * 0.8); // Get top articles whose total is at least 80% of total score
    let topArticles = [];
    while (allArticles.length > 0 && threshold > 0) {
        threshold -= allArticles[0].score;
        topArticles.push(allArticles.shift());
    }
    // get the smaller amount of topArticles within a sensible range
    return potentialReturn.length < topArticles.length ? potentialReturn : topArticles;
};

/**
 * Returns a string of the most common terms in the given object of articles, sorted by frequency and score.
 *
 * @param {Object} allResults - An object containing arrays of articles for each term.
 * @return {string} A string of the most common terms, separated by '/' - DISCLAIMER: NORMALLY IT'S A SINGLE TERM        */
function mostCommonTerms(allResults) {
    const termCount = {};

    for (const [term, articles] of Object.entries(allResults)) {
        termCount[term] = articles.length;
    }

    const totalArticles = Object.values(allResults).flat().length;

    if (totalArticles === 1) {
        return Object.keys(termCount)[0];
    }

    const sortedTerms = Object.entries(termCount).sort((a, b) => b[1] - a[1]);
    const highestFrequency = sortedTerms[0][1];
    let topTerms = sortedTerms.filter(term => term[1] === highestFrequency);

    const numOfTopics = Math.floor(Math.cbrt(totalArticles));

    topTerms = topTerms.sort((a, b) => {
        const aMaxScore = Math.max(...allResults[a[0]].map(article => article.score));
        const bMaxScore = Math.max(...allResults[b[0]].map(article => article.score));
        return bMaxScore - aMaxScore;
    }).slice(0, numOfTopics).map(term => term[0]);

    return topTerms.join('/');
}

/**
 * Loads the results from a JSON file.
 *
 * @return {Object} The loaded results, or null if the file doesn't exist.  */
const loadResults = () => {
    console.log("Loading results...");
    const resultsPath = path.join(__dirname, CRAWLED_RESULTS_JSON);
    if (fs.existsSync(resultsPath)) {
        return JSON.parse(fs.readFileSync(resultsPath));
    }
    return null;
};

const sendEmail = async (emailTime) => {
    console.log("Sending emails...");

    const now = new Date();
    const results = loadResults();
    const sender = config.email.sender;
    const recipients = config.email.recipients;
    const totalLinks = Object.values(results.results).flat().length ?? 0;
    const sortedResults = Object.entries(results.results).sort((a, b) => b[1].length - a[1].length) ?? [];

    let mostFrequentTerm = results.mostCommonTerm ?? EMPTY_STRING;
    const subject = `Noticias Frescas ${todayDate()} - ${mostFrequentTerm}`;
    let topArticles = results.topArticles ?? [];

    //Edge case of topArticles not extracted yet
    if (totalLinks > 0) {
        if (topArticles == []) {
            topArticles = await extractTopArticles(results.results);
        }
        if (mostFrequentTerm === MOST_COMMON_TERM || mostFrequentTerm === EMPTY_STRING) {
            mostFrequentTerm = mostCommonTerms(results.results);
        }
    }

    //Edge case of summaries not being present
    for (let i = 0; i < topArticles.length; i++) {
        let link = EMPTY_STRING, summary = EMPTY_STRING;
        if (topArticles[i].summary === STRING_PLACEHOLDER ||
            topArticles[i].summary.includes(FAILED_SUMMARY_MSSG)) {
            ({ url: link, response: summary } = await summarizeText(
                topArticles[i].link,
                topArticles[i].fullText,
                topArticles[i].term,
                topArticles[i].title
            ));
            topArticles[i].summary = summary;
            topArticles[i].link = link !== EMPTY_STRING ? link : topArticles[i].link;
        }
    }


    while (now < new Date(emailTime.getTime() + MINUTES_TO_CLOSE)) {
        console.log("Waiting...");
        await new Promise((r) => setTimeout(r, 90000));
        now.setTime(Date.now());
    }

    let topArticleLinks = [];

    let emailBody = `
        <div style="text-align: center;">
            <img src="https://raw.githubusercontent.com/V3RNE42/NEWS_CRAWLER/puppeteer_variant/assets/fresh_news.png" style="max-width: 25%; height: auto; display: block; margin-left: auto; margin-right: auto;" alt="Noticias_Frescas_LOGO">
        </div>
        <br>
        Estas son las ${totalLinks} noticias frescas de ${todayDate()} :<br><br>`;

    if (topArticles.length) {
        emailBody += "Noticias Destacadas:<br><br>";
        topArticles.forEach((article) => {
            emailBody += `<a href="${article.link}">${article.title}</a><br>${article.summary}<br><br>`;
            topArticleLinks.push(article.link);
        });
    } else {
        emailBody += `<b>NO encontré noticias destacadas hoy</b><br>`;
    }

    emailBody += "<br>"

    sortedResults.forEach(([term, articles]) => {
        if (articles.length) {
            emailBody += `<b>${term.toUpperCase()} - ${articles.length} link${articles.length === 1 ? EMPTY_STRING : "s"}</b><br>`;
            articles.forEach((article) => {
                let isTopArticle = topArticleLinks.includes(article.link);
                emailBody += `<a href="${article.link}" style="color: ${isTopArticle ? "red" : "blue"};">${article.title}</a><br>`;
            });
            emailBody += "<br><br>";
        }
    });

    emailBody += "<br>¡Saludos!";

    const transporter = nodemailer.createTransport({
        host: config.email.smtp_server,
        port: config.email.smtp_port,
        secure: false,
        auth: {
            user: config.email.smtp_user,
            pass: config.email.smtp_pass,
        },
    });

    const mailOptions = {
        from: sender,
        to: recipients.join(", "),
        subject: subject,
        html: emailBody,
    };

    try {
        await transporter.sendMail(mailOptions);
        console.log("Emails sent successfully!");

        fs.unlinkSync(path.join(__dirname, CRAWL_COMPLETE_FLAG));
        fs.unlinkSync(path.join(__dirname, CRAWLED_RESULTS_JSON));
        console.log("Cleanup complete: Deleted flag and results files.");
    } catch (error) {
        console.error(`Error sending emails: ${error}`);
    }
};


const main = async () => {
    console.log("Starting main process...");
    let resultados;
    let emailTime = new Date();

    while (!fs.existsSync(path.join(__dirname, CRAWL_COMPLETE_FLAG))) {
        console.log("Starting new crawling cycle...");
        globalStopFlag = false; // Reset the flag at the start of each cycle

        const now = new Date();
        emailTime = parseTime(config.time.email);
        console.log('Current emailEndTime:', emailTime);

        const crawlCycleEndTime = new Date(now.getTime() + 15 * 60 * 1000); // 1/4 hour from now
        const cycleEndTime = emailTime < crawlCycleEndTime ? emailTime : crawlCycleEndTime;

        console.log(`Cycle end time set to: ${cycleEndTime}`);

        resultados = loadPreviousResults();
        console.log("Previous results loaded.");

        const results = await crawlWebsites(cycleEndTime);
        console.log("Crawling completed. Processing results...");

        for (const [term, articles] of Object.entries(results)) {
            if (!resultados[term]) resultados[term] = [];
            resultados[term].push(...articles);
        }

        await saveResults(resultados, emailTime);
        console.log("Results saved.");

        if (globalStopFlag) {
            console.log("Stopping main loop due to global stop flag");
            break;
        }

        console.log("Cycle completed. Checking if it's time to send email...");
        if (closeToEmailingTime(emailTime)) {
            console.log("It's time to send email. Breaking the loop.");
            break;
        }

        console.log("Waiting before starting next cycle...");
        await new Promise(resolve => setTimeout(resolve, 60000)); // 1 minute delay
    }

    if (!fs.existsSync(path.join(__dirname, CRAWL_COMPLETE_FLAG)) && !(FALSE_ALARM)) {
        fs.writeFileSync(path.join(__dirname, CRAWL_COMPLETE_FLAG), CRAWL_COMPLETE_TEXT);
        console.log("Crawl complete flag created.");
    }

    console.log("Preparing to send email...");
    await sendEmail(emailTime);
    console.log("Email sent. Main process completed.");
};

if (isMainThread) {
    // Main thread code
    (async () => {
        await assignBrowserPath();
        console.log(`Webcrawler scheduled to run indefinitely. Emails will be sent daily at ${config.time.email}`);

        while (true) {
            console.log(`Running the web crawler at ${new Date().toISOString()}...`);
            await main()
                .then(() => console.log('Scheduled webcrawler run finished successfully\n\n\n'))
                .catch(error => console.error('Error in scheduled webcrawler run:', error, '\n\n\n'));
        }
    })();
} else {
    // Worker thread code
    (async () => {
        const { websites, terms, addedLinks: initialAddedLinks, cycleEndTime } = workerData;
        let workerAddedLinks = new Set(initialAddedLinks);

        const results = {};
        for (const term of terms) results[term] = new Set();

        for (const url of websites) {
            if (Date.now() >= cycleEndTime.getTime()) {
                console.log(`Worker reached cycle end time, stopping.`);
                break;
            }
            try {
                const websiteResults = await crawlWebsite(url, terms, workerAddedLinks);
                for (const [term, articles] of Object.entries(websiteResults)) {
                    articles.forEach(article => {
                        results[term].add(article);
                        if (!workerAddedLinks.has(article.link)) {
                            workerAddedLinks.add(article.link);
                            parentPort.postMessage({ type: 'addLinks', links: [article.link] });
                        }
                    });
                }
                // Send progress update
                parentPort.postMessage({
                    type: 'progress',
                    result: {
                        articles: Object.fromEntries(Object.entries(results).map(([k, v]) => [k, Array.from(v)]))
                    }
                });
            } catch (error) {
                console.error(`Error crawling ${url}: ${error}`);
            }
        }

        // Send final result
        parentPort.postMessage({
            type: 'result',
            result: {
                articles: Object.fromEntries(Object.entries(results).map(([k, v]) => [k, Array.from(v)]))
            }
        });
    })();
}