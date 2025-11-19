const fs = require('fs');
const path = require('path');
const config = require('../config.json');
const { removeIrrelevantArticles, removeRedundantArticles, extractTopArticles, mostCommonTerms, extractArticleTextWithRetry } = require('./scraper');
const { summarizeText } = require('./ai');
const { getFullText } = require('./storage');
const { sleep, closeToEmailingTime } = require('./utils');
const { CRAWLED_RESULTS_JSON, CRAWL_COMPLETE_FLAG, CRAWL_COMPLETE_TEXT, SAFE_TO_REBOOT_FLAG, SAFE_REBOOT_MESSAGE, STRING_PLACEHOLDER, FAILED_SUMMARY_MSSG, EMPTY_STRING, MOST_COMMON_TERM } = require('./constants');
const { safePath } = require('./system');

const IGNORE_REDUNDANCY = config.text_analysis.ignore_redundancy;

const loadResults = () => {
    const resultsPath = path.join(__dirname, '../', CRAWLED_RESULTS_JSON);
    if (fs.existsSync(resultsPath)) {
        const data = fs.readFileSync(resultsPath, 'utf8');
        return JSON.parse(data);
    }
    return { results: {} };
};

const saveResults = async (results, emailTime, terms) => {
    await sleep(30000);
    console.log("Saving results...");
    const resultsPath = path.join(__dirname, '../', CRAWLED_RESULTS_JSON);
    const flagPath = path.join(__dirname, '../', CRAWL_COMPLETE_FLAG);
    let topArticles = [];
    let numTopArticles = 0;
    let mostCommonTerm = MOST_COMMON_TERM;
    let link = EMPTY_STRING, summary = EMPTY_STRING;

    try {
        if (fs.existsSync(safePath)) {
            await fs.unlinkSync(safePath);
            console.log("Removed 'safe to reboot' flag");
        }
    } catch (error) {
        if (error.code !== 'ENOENT') console.error("Error removing safe to reboot flag:", error);
    }

    const thisIsTheTime = closeToEmailingTime(emailTime);
    if (thisIsTheTime) {
        results = await removeIrrelevantArticles(results, terms);
        if (!IGNORE_REDUNDANCY) {
            results = await removeRedundantArticles(results, terms);
        }
        topArticles = extractTopArticles(results);
        numTopArticles = topArticles.length;
        for (let i = 0; i < numTopArticles; i++) {
            if (topArticles[i].summary === STRING_PLACEHOLDER ||
                topArticles[i].summary.includes(FAILED_SUMMARY_MSSG)) {
                try {
                    let fullText = await getFullText(topArticles[i].link);
                    if (!fullText) {
                        fullText = await extractArticleTextWithRetry(topArticles[i].link);
                    }
                    ({ url: link, response: summary } = await summarizeText(
                        topArticles[i].link,
                        fullText,
                        numTopArticles,
                        topArticles[i].title));
                    topArticles[i].summary = summary;
                    topArticles[i].link = link !== EMPTY_STRING ? link : topArticles[i].link;
                } catch (error) {
                    console.log(`There was an error summarizing article: ${error}`);
                }
            }
        }
        mostCommonTerm = mostCommonTerms(results);
    }

    const resultsWithTop = { results, topArticles, mostCommonTerm };

    fs.writeFileSync(resultsPath, JSON.stringify(resultsWithTop, null, 2), 'utf8');
    if (thisIsTheTime) {
        fs.writeFileSync(flagPath, CRAWL_COMPLETE_TEXT);
        console.log(CRAWL_COMPLETE_TEXT);
        return true;
    }

    return false;
};

module.exports = {
    loadResults,
    saveResults
};
