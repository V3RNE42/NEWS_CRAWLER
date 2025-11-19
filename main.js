const { initializeLogger, saveLog } = require('./modules/logger');
const { checkSafeAndReboot, forceGarbageCollection } = require('./modules/system');
const { ensureTempDir, cleanupTempFiles } = require('./modules/storage');
const { assignBrowserPath } = require('./modules/browser');
const { crawlWebsites } = require('./modules/scraper');
const { saveResults, loadResults } = require('./modules/results_manager');
const { sendEmail } = require('./modules/email');
const { todayDate, parseTime, sleep, LightweightError } = require('./modules/utils');
const { state, resetGlobalLinks } = require('./modules/state');
const config = require('./config.json');
const { terms, websites } = require('./terminos');
const { CRAWL_COMPLETE_FLAG, SAFE_TO_REBOOT_FLAG, INITIAL_DELAY, MINUTES_TO_CLOSE } = require('./modules/constants');

// Initialize Logger
const originalConsole = initializeLogger();

process.on('uncaughtException', (error) => {
    console.error(`Uncaught Exception: ${error.message}`);
    checkSafeAndReboot(error);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
    checkSafeAndReboot(reason);
});

(async () => {
    try {
        await assignBrowserPath();
        await ensureTempDir();

        const emailTime = parseTime(config.time.email);
        let cycleEndTime = new Date();
        cycleEndTime.setTime(cycleEndTime.getTime() + 1000 * 60 * 60 * 2); // 2 hours default

        // Main Loop
        while (true) {
            resetGlobalLinks();
            state.stopFlag = false;

            const now = new Date();
            const timeUntilEmail = emailTime.getTime() - now.getTime();

            if (timeUntilEmail > 0 && timeUntilEmail < MINUTES_TO_CLOSE) {
                cycleEndTime = emailTime;
            } else {
                cycleEndTime = new Date(now.getTime() + 1000 * 60 * 60 * 2); // 2 hours
            }

            console.log(`Starting crawl cycle. Cycle ends at: ${cycleEndTime.toLocaleTimeString()}`);

            try {
                let results = loadResults();
                const currentResults = await crawlWebsites(cycleEndTime, terms, websites);

                // Merge results
                for (const [term, articles] of Object.entries(currentResults)) {
                    if (!results.results) results.results = {};
                    if (!results.results[term]) results.results[term] = [];
                    results.results[term].push(...articles);
                }

                const crawlCompleted = await saveResults(results.results, emailTime, terms);

                if (crawlCompleted) {
                    await sendEmail(emailTime, loadResults);
                    await cleanupTempFiles();
                    forceGarbageCollection();

                    // Wait until next day or restart cycle
                    console.log("Daily cycle completed. Waiting for next cycle...");
                    await sleep(60000 * 60); // Sleep for an hour
                }

            } catch (error) {
                console.error(`Error in main loop: ${error.message}`);
                saveLog('main_loop_error');
            }

            forceGarbageCollection();
            await sleep(INITIAL_DELAY);
        }

    } catch (error) {
        console.error(`Fatal error: ${error.message}`);
        saveLog('fatal_error');
        process.exit(1);
    }
})();