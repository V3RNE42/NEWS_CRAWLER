const { Resend } = require('resend');
const fs = require('fs');
const path = require('path');
const config = require('../config.json');
const { todayDate, closeToEmailingTime } = require('./utils');
const { getFullText } = require('./storage');
// I put saveResults in system.js in my plan?
// Let's check system.js content.
// I put checkSafeAndReboot, initiateReboot, forceGarbageCollection in system.js.
// I put saveFullText, getFullText in storage.js.
// I put loadResults in system.js? No, I haven't implemented loadResults/saveResults in system.js yet.
// I missed them in system.js?
// I checked system.js content in step 61. It has checkSafeAndReboot, initiateReboot, forceGarbageCollection.
// It does NOT have loadResults, saveResults.
// I need to implement them.
// They depend on removeIrrelevantArticles, removeRedundantArticles, extractTopArticles, mostCommonTerms which are in scraper.js.
// So saveResults cannot be in system.js if system.js is low-level.
// saveResults is high-level logic.
// Maybe I should put them in `scraper.js` or a new `manager.js`?
// Or `email.js`? No, saveResults is about saving crawl results.
// `main.js` calls `saveResults`.
// I'll put `saveResults` and `loadResults` in `scraper.js` or `modules/results_manager.js`.
// `scraper.js` already has `extractTopArticles`, etc.
// So `scraper.js` is a good place for `saveResults` logic, or `main.js` can handle it using `scraper.js` functions.
// But `saveResults` is quite complex.
// I'll put `saveResults` and `loadResults` in `scraper.js` for now, or `modules/results.js`.
// Let's create `modules/results.js` to avoid circular dependency if `scraper.js` needs `saveResults` (it doesn't).
// But `saveResults` needs `scraper.js` functions.
// So `results.js` depends on `scraper.js`.
// And `main.js` depends on `results.js`.
// This works.

// Let's pause email.js creation and create results.js first?
// Or just put them in email.js? No.
// I'll put them in `modules/results.js`.

// Back to email.js
// It needs sendEmailToRecipient and sendEmail.
// sendEmail needs loadResults, extractTopArticles, summarizeText, etc.
// So email.js depends on results.js (for loadResults) and scraper.js (for extractTopArticles) and ai.js (for summarizeText).

const { extractTopArticles, mostCommonTerms } = require('./scraper');
const { summarizeText } = require('./ai');
const { extractArticleTextWithRetry } = require('./scraper');
const { CRAWL_COMPLETE_FLAG, CRAWLED_RESULTS_JSON, SAFE_TO_REBOOT_FLAG, SAFE_REBOOT_MESSAGE, STRING_PLACEHOLDER, FAILED_SUMMARY_MSSG, EMPTY_STRING, MOST_COMMON_TERM, CRAWL_COMPLETE_TEXT } = require('./constants');
const { saveLog, clearConsole } = require('./logger');
const { safePath } = require('./system');

const resend = new Resend(config.email.RESEND_API_KEY);

async function sendEmailToRecipient(sender, recipient, subject, htmlBody) {
    await resend.emails.send({
        from: sender,
        to: recipient,
        subject: subject,
        html: htmlBody
    });
}

const sendEmail = async (emailTime, loadResultsFn) => {
    console.log("Sending emails...");

    try {
        if (fs.existsSync(safePath)) {
            await fs.unlinkSync(safePath);
            console.log("Removed 'safe to reboot' flag");
        }
    } catch (error) {
        if (error.code !== 'ENOENT') console.error("Error removing safe to reboot flag:", error);
    }

    const now = new Date();
    const results = loadResultsFn(); // Dependency injection or import
    const sender = config.email.sender;
    const recipients = config.email.recipients;

    if (!results || !results.results) {
        console.error("No results to send.");
        return;
    }

    const totalLinks = Object.values(results.results).flat().length ?? 0;
    const sortedResults = Object.entries(results.results).sort((a, b) => b[1].length - a[1].length) ?? [];

    let mostFrequentTerm = results.mostCommonTerm ?? EMPTY_STRING;
    const subject = `Noticias Frescas ${todayDate()} - ${mostFrequentTerm}`;
    let topArticles = results.topArticles ?? [];

    //Edge case of topArticles not extracted yet
    if (totalLinks > 0) {
        if (topArticles.length === 0) {
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
            try {
                let fullText = await getFullText(topArticles[i].link);
                if (!fullText) {
                    fullText = await extractArticleTextWithRetry(topArticles[i].link);
                }
                ({ url: link, response: summary } = await summarizeText(
                    topArticles[i].link,
                    fullText,
                    topArticles.length,
                    topArticles[i].title));
                topArticles[i].summary = summary;
                topArticles[i].link = link !== EMPTY_STRING ? link : topArticles[i].link;
            } catch (error) {
                console.log(`There was an error summarizing article: ${error}`);
            }
        }
    }


    while (now < new Date(emailTime.getTime() + 15 * 60000)) { // MINUTES_TO_CLOSE hardcoded or imported
        console.log("Waiting...");
        await new Promise((r) => setTimeout(r, 30000));
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
            emailBody += `<b>${term.toUpperCase()} ${articles.length === 1 ? EMPTY_STRING : " - " + articles.length + " links"}</b><br>`;
            articles.forEach((article) => {
                let isTopArticle = topArticleLinks.includes(article.link);
                emailBody += articles.length > 1 ? '<b>-</b> ' : EMPTY_STRING;
                emailBody += `<a href="${article.link}" style="color: ${isTopArticle ? "red" : "blue"};">${article.title}</a><br>`;
            });
            emailBody += "<br><br>";
        }
    });

    emailBody += "<br>¡Saludos!";

    try {

        for (const recipient of recipients) {
            await sendEmailToRecipient(sender, recipient, subject, emailBody);
        };

        console.log("Emails sent successfully!");

        const crawlCompleteFlagPath = path.join(__dirname, '../', CRAWL_COMPLETE_FLAG);
        const resultsPath = path.join(__dirname, '../', CRAWLED_RESULTS_JSON);

        if (fs.existsSync(crawlCompleteFlagPath)) fs.unlinkSync(crawlCompleteFlagPath);
        if (fs.existsSync(resultsPath)) fs.unlinkSync(resultsPath);

        console.log("Cleanup complete: Deleted flag and results files.");
    } catch (error) {
        console.error(`Error sending emails: ${error}`);
        saveLog('email_error');
    } finally {
        fs.writeFileSync(safePath, SAFE_REBOOT_MESSAGE);
        clearConsole();
    }
};

module.exports = {
    sendEmail,
    sendEmailToRecipient
};
