//MODULES AND IMPORTS
import nodemailer from "nodemailer";
import fs from "fs";
import path from "path";
import { fileURLToPath } from 'url';
import { dirname } from 'path';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

import cheerio from "cheerio";
import { OpenAI } from "openai";
import puppeteer from "puppeteer";
import { Worker, isMainThread, parentPort, workerData } from 'worker_threads';
import os from 'os';
import { terms as Terms, websites } from "./terminos.mjs";
let terms = Terms;
import pkg from 'fs-extra';
const { readJson } = pkg;
const config = await readJson("config.json");

import { getMainTopics, sanitizeHtml } from "./text_analysis/topics_extractor.mjs";
import { coveringSameNews } from "./text_analysis/natural_processing.mjs";
import { findValidChromiumPath } from "./browser/browserPath.mjs";
import { crawlWebsite } from "./crawlWebsite.mjs";

//IMPORTANT CONSTANTS AND SETTINGS
const openai = new OpenAI({ apiKey: config.openai.api_key });
const LANGUAGE = config.text_analysis.language;
const SENSITIVITY = config.text_analysis.topic_sensitivity;
const MAX_TOKENS_PER_CALL = config.openai.max_tokens_per_call;
const SIMILARITY_THRESHOLD = config.text_analysis.max_similarity;
const MINUTES_TO_CLOSE = 5 * 60000;
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
let globalStopFlag = false;

//FUNCTIONS
/** Parses a time string in the format HH:MM (24-hour format) and returns a Date object
 * representing the time. If the time string is invalid or the hour or minute is not a number,
 * an Error is thrown.
 *
 * @param {string} timeStr - The time string to be parsed.
 * @return {Date} A Date object representing the parsed time.
 * @throws {Error} If the time string is invalid or the hour or minute is not a number. */
const parseTime = (timeStr) => {
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
    result.setMinutes(result.getMinutes() - Math.floor(MINUTES_TO_CLOSE / 60000));
    if (result <= now) {
        result.setDate(result.getDate() + 1);
    }
    return result;
};

/** Assigns a valid browser path to the BROWSER_PATH variable based on the configuration
 * @return {Promise<void>} A promise that resolves when the browser path is assigned.   */
async function assignBrowserPath() {
    BROWSER_PATH = config.browser.path === STRING_PLACEHOLDER
        ? await findValidChromiumPath()
        : config.browser.path;
}

/** Generates the current date in the format DD/MM/YYYY.
 *
 * @return {string} The formatted current date. */
function todayDate() {
    const date = new Date();
    const day = date.getDate().toString().padStart(2, '0');
    const spanishMonths = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
    const month = spanishMonths[date.getMonth()];
    const year = date.getFullYear();
    return `${day}/${month}/${year}`;
}

/** Asynchronously delays the execution of code for a specified amount of time.
 * 
 *  @param {number} ms - The number of milliseconds to delay the execution.
 *  @return {Promise<void>} A Promise that resolves after the specified delay.   */
async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/** Extracts the text content of an article from a given URL.
 *
 * @param {string} url - The URL of the article.
 * @return {Promise<string>} A Promise that resolves to the extracted text content. */
async function extractArticleText(url) {
    let articleText = "";
    try {
        const browser = await puppeteer.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox'],
            executablePath: BROWSER_PATH
        });
        const page = await browser.newPage();
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        articleText = await page.evaluate(() => {
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
        try {
            const response = await fetch(url);
            const html = await response.text();
            const $ = cheerio.load(html);
            articleText = $.html();
            return cleanText(articleText);
        } catch (error) {
            console.error(`Error extracting text from ${url}: ${error.message}`);
            return EMPTY_STRING;
        }
    }
}

/** Cleans the given text by removing HTML tags and trimming whitespace
 * @param {string} text - The text to be cleaned.
 * @return {string} The cleaned text.     */
const cleanText = (text) => {
    text = sanitizeHtml(text, { allowedTags: [], allowedAttributes: [] });
    while (text.includes("\n")) {
        text = text.replace(/\n/g, ' ');
    }
    while (text.includes("\t")) {
        text = text.replace(/\t/g, ' ');
    }
    while (text.includes('  ')) {
        text = text.replace(/'  '/g, ' ');
    }
    return text.replace(/<[^>]*>/g, ' ').trim();
}

/** Generates a prompt for OpenAI to generate a summary of a specific part of a news article.
 *
 * @param {string} text - The content of the news article.
 * @param {string} topic - The topic of the news article.
 * @param {number} maxTokens - The maximum number of tokens for the OpenAI response.
 * @return {Promise<string>} The generated prompt for OpenAI.   */
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

/** Asynchronously generates a non-chunked OpenAI response for a given text, topic, and maximum number of tokens.
 *
 * @param {string} text - The content of the news article.
 * @param {string} topic - The topic of the news article.
 * @param {number} maxTokens - The maximum number of tokens for the OpenAI response.
 * @return {Promise<string>} The generated OpenAI response. */
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

/** Retrieves an OpenAI response for the given text and title.
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

/** Retrieves the content of a webpage behind a paywall by using a proxy website.
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

/** Retrieves a summary of the text using OpenAI's GPT-4 model.
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

/** Normalizes a URL by trimming whitespace and converting to lowercase.
 *
 * @param {string} url - The URL to be normalized.
 * @return {string} The normalized URL.*/
const normalizeUrl = (url) => {
    let normalizedUrl = url.trim().toLowerCase();
    if (normalizedUrl.endsWith('/')) {
        normalizedUrl = normalizedUrl.slice(0, -1);
    }
    return normalizedUrl;
};

/** Checks if the current time is close to the provided email end time.
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

/** Splits an array into a specified number of chunks.
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


function shuffleArray(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        const temp = array[i];
        array[i] = array[j];
        array[j] = temp;
    }
    return array;
}

/** Crawls multiple websites for articles related to specified terms.
 *
 * @return {Promise<Object>} An object containing arrays of articles for each term. */
/** Crawls multiple websites for articles related to specified terms.
 *
 * @return {Promise<Object>} An object containing arrays of articles for each term. */
const crawlWebsites = async (cycleEndTime) => {
    console.log("Starting crawlWebsites function...");
    let allResults = {};
    for (const term of terms) allResults[term] = [];
    const shuffledWebsites = shuffleArray([...websites]);
    const maxConcurrentWorkers = os.cpus().length;
    const websiteChunks = chunkArray(shuffledWebsites, maxConcurrentWorkers);
    console.log(`Creating ${maxConcurrentWorkers} worker(s)...`);

    const workerPromises = websiteChunks.map((websiteChunk, index) =>
        new Promise(async (resolve) => {
            console.log(`Worker ${index} starting...`);
            let workerAddedLinks = new Set(addedLinks);
            let chunkResults = {};
            for (const website of websiteChunk) {
                if (Date.now() >= cycleEndTime.getTime()) {
                    console.log(`Worker ${index} reached cycle end time, stopping.`);
                    break;
                }
                console.log(`Worker ${index} crawling ${website}...`);
                try {
                    const results = await crawlWebsite(website, terms, workerAddedLinks, new Date(cycleEndTime));
                    for (const [term, articles] of Object.entries(results)) {
                        if (!chunkResults[term]) chunkResults[term] = [];
                        chunkResults[term].push(...articles);
                    }
                    console.log(`Worker ${index} found ${Object.values(results).flat().length} articles on ${website}`);
                } catch (error) {
                    console.error(`Error crawling ${website}: ${error.message}`);
                }
            }
            console.log(`Worker ${index} finished. Total found: ${Object.values(chunkResults).flat().length} articles.`);
            resolve({ articles: chunkResults, addedLinks: Array.from(workerAddedLinks) });
        })
    );

    const timeoutPromise = new Promise(resolve => {
        const timeoutMs = cycleEndTime.getTime() - Date.now();
        setTimeout(() => {
            console.log("Timeout reached. Forcing collection of results...");
            resolve('timeout');
        }, timeoutMs > 0 ? timeoutMs : 0);
    });

    await Promise.race([Promise.all(workerPromises), timeoutPromise]);

    console.log("Collecting final results...");
    const collectedResults = await Promise.all(
        workerPromises.map(async (workerPromise, index) => {
            try {
                const result = await Promise.race([
                    workerPromise,
                    new Promise((_, reject) => setTimeout(() => reject(new Error('Worker timeout')), 60000)) // 60 second timeout
                ]);
                console.log(`Successfully collected results from worker ${index}.`);
                return result;
            } catch (error) {
                console.error(`Error retrieving results from worker ${index}:`, error);
                return null;
            }
        })
    );

    for (const workerResult of collectedResults) {
        if (workerResult && workerResult.articles) {
            for (const [term, articles] of Object.entries(workerResult.articles)) {
                if (!allResults[term]) allResults[term] = [];
                allResults[term].push(...articles);
            }
            workerResult.addedLinks.forEach(link => addedLinks.add(link));
        }
    }

    const totalArticles = Object.values(allResults).flat().length;
    console.log(`All results collected. Found total of ${totalArticles} articles.`);
    console.log("Articles per term:");
    for (const [term, articles] of Object.entries(allResults)) {
        console.log(`  ${term}: ${articles.length} articles`);
    }
    return allResults;
};

/** Removes redundant articles from the given results object.
 *
 * @param {Object} results - An object containing articles grouped by terms.
 * @return {Promise<void>} A promise that resolves when the redundant articles have been removed.   */
const removeRedundantArticles = async (results) => {
    console.log('Removing redundant articles...');
    for (const term of terms) {
        const articles = results[term];
        const uniqueArticles = [];
        const toRemove = new Set();
        for (let i = 0; i < articles.length; i++) {
            if (toRemove.has(i)) continue;
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
                        break;
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

/** Determines if a given text is relevant based on the frequency of terms.
 *
 * @param {string} textToAnalyze - The text to analyze.
 * @param {Array<string>} terms - The terms to check for in the text.
 * @return {boolean} - Returns true if the total frequency of terms in the text is greater than or equal to 2, false otherwise. */
function isTextRelevant(textToAnalyze, terms) {
    const textLower = textToAnalyze.toLowerCase();
    let totalFrequency = 0;
    for (let term of terms) {
        const regex = new RegExp(`\\b${term}\\b`, 'g');
        const matches = textLower.match(regex);
        const count = matches ? matches.length : 0;
        totalFrequency += count;
        if (totalFrequency >= 2) break;
    }
    return totalFrequency >= 2;
}


/** Reorganizes the articles in the results object by term, removing irrelevant articles based on specified criteria.
 *
 * @param {Object} results - An object containing articles grouped by terms.
 * @return {Object} An object with articles reorganized by term after removing irrelevant articles. */
async function removeIrrelevantArticles(results) {
    let reorganizedResults = {};
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
                    continue;
                }
            }
            let title = article.title;
            let textToAnalyze = title.concat(' ', article.fullText);
            let mainTopics = getMainTopics(textToAnalyze, LANGUAGE, SENSITIVITY);
            if ((!mainTopics.some(topic => terms.includes(topic.toLowerCase())) || !isTextRelevant(textToAnalyze, terms))
                && article.score === 1) {
                console.log(`Irrelevant article discarded: ${article.link}`);
                continue;
            }
            reorganizedResults[term].push(article);
        }
    }
    return reorganizedResults;
}

/** Saves the results to a JSON file.
 *
 * @param {Object} results - The results to be saved.
 * @return {Promise<boolean>} - A promise that resolves to a boolean indicating if the crawling is complete.    */
const saveResults = async (results, emailTime) => {
    console.log(`These are the results: ${results}`);
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
                    numTopArticles,
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

/** Loads the previous results from the `crawled_results.json` file.
 * @return {Object} The previous results, or an empty object if the file doesn't exist or cannot be parsed. */
const loadPreviousResults = () => {
    console.log("Loading previous results...");
    const resultsPath = path.join(__dirname, CRAWLED_RESULTS_JSON);
    try {
        if (fs.existsSync(resultsPath)) {
            const fileContent = fs.readFileSync(resultsPath, 'utf8');
            let previousResults = JSON.parse(fileContent);
            if (!previousResults.results) {
                throw new Error('Invalid results structure');
            }
            for (const articles of Object.values(previousResults.results)) {
                articles.forEach(article => addedLinks.add(article.link));
            }
            for (let term of terms) {
                if (previousResults.results[term] == undefined || 
                    previousResults.results[term] == null) {
                    previousResults.results[term] = [];
                }
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

/** Extracts the top articles from the given results.
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

/** Returns a string of the most common terms in the given object of articles, sorted by frequency and score.
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

/** Loads the results from a JSON file.
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

/** Sends an email with the latest news based on the results stored in the JSON file.
 *
 * @param {Date} emailTime - The time at which the email should be sent.
 * @return {Promise<void>} - A promise that resolves when the email is sent successfully.   */
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
                topArticles.length,
                topArticles[i].title
            ));
            topArticles[i].summary = summary;
            topArticles[i].link = link !== EMPTY_STRING ? link : topArticles[i].link;
        }
    }
    while (now < new Date(emailTime.getTime() + MINUTES_TO_CLOSE)) {
        console.log("Waiting...");
        await sleep(30000);
        now.setTime(Date.now());
    }
    let topArticleLinks = [];
    let emailBody = `
        <div style="text-align: center;">
            <img src="https://github.com/V3RNE42/NEWS_CRAWLER/blob/main/assets/fresh_news.png?raw=true" style="max-width: 25%; height: auto; display: block; margin-left: auto; margin-right: auto;" alt="Noticias_Frescas_LOGO">
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

/** Asynchronous function that controls the main process of the web crawler.
 *
 * @return {Promise<void>} Promise that resolves when the main process is completed */
async function main() {
    console.log("Starting main process...");
    let resultados;
    let emailTime = new Date();
    while (!fs.existsSync(path.join(__dirname, CRAWL_COMPLETE_FLAG))) {
        console.log("Starting new crawling cycle...");
        globalStopFlag = false;
        const now = new Date();
        emailTime = parseTime(config.time.email);
        const chunkedWebsitesCount = Math.floor(websites.length/os.cpus().length);
        const crawlCycleEndTime = new Date(now.getTime() + chunkedWebsitesCount * terms.length * 150);
        const cycleEndTime = emailTime < crawlCycleEndTime ? emailTime : crawlCycleEndTime;
        console.log(`Cycle end time set to: ${cycleEndTime}`);
        resultados = loadPreviousResults();
        console.log("Previous results loaded.");

        const newResults = await crawlWebsites(cycleEndTime);

        // Merge new results with previous results
        for (const [term, articles] of Object.entries(newResults)) {
            if (!resultados[term]) resultados[term] = [];
            resultados[term].push(...articles);
        }

        console.log('++++++++++++++++++++++++++++++++++++++');
        console.log(`++++++++++++++ Current articles: ${Object.values(resultados).flat().length} ++`);
        console.log('++++++++++++++++++++++++++++++++++++++');
        
        const shouldStop = await saveResults(resultados, emailTime);
        console.log("Results saved.");
        
        if (shouldStop || globalStopFlag) {
            console.log("Stopping main loop");
            break;
        }
        
        console.log("Waiting before starting next cycle...");
        await sleep(30000);
    }

    if (!fs.existsSync(path.join(__dirname, CRAWL_COMPLETE_FLAG)) && !(FALSE_ALARM)) {
        fs.writeFileSync(path.join(__dirname, CRAWL_COMPLETE_FLAG), CRAWL_COMPLETE_TEXT);
        console.log("Crawl complete flag created.");
    }
    
    console.log("Preparing to send email...");
    await sendEmail(emailTime);
    console.log("Email sent. Main process completed.");
}

if (isMainThread) {
    // Main thread code
    (async () => {
        await assignBrowserPath();
        console.log(`Webcrawler scheduled to run indefinitely. Emails will be sent daily at ${config.time.email}`);
        while (true) {
            console.log(`Running the web crawler at ${new Date().toISOString()}...`);
            globalStopFlag = false; // Reset the flag before each run
            try {
                await main();
                console.log('Scheduled webcrawler run finished successfully\n\n\n');
            } catch (error) {
                console.error('Error in scheduled webcrawler run:', error, '\n\n\n');
            }
            // Wait before starting the next cycle
            await new Promise(resolve => setTimeout(resolve, 60000)); // 1 minute delay
        }
    })();
} else {
    // Worker thread code
    (async () => {
        const { websites, terms, addedLinks: initialAddedLinks, cycleEndTime } = workerData;
        let workerAddedLinks = new Set(initialAddedLinks);
        const results = {};
        for (const term of terms) results[term] = new Set();

        parentPort.on('message', (message) => {
            if (message === 'terminate') {
                // Send final result
                parentPort.postMessage({
                    type: 'result',
                    result: {
                        articles: Object.fromEntries(Object.entries(results).map(([k, v]) => [k, Array.from(v)]))
                    }
                });
                console.log('Worker received terminate signal');
                process.exit(0);
            }
        });

        for (const url of websites) {
            if (Date.now() >= cycleEndTime.getTime()) {
                console.log(`Worker reached cycle end time, stopping.`);
                break;
            }
            try {
                const websiteResults = await crawlWebsite(url, terms, workerAddedLinks, new Date(cycleEndTime));
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
