const { parentPort, workerData } = require('worker_threads');
const { crawlWebsite } = require('./scraper');
const { LightweightError } = require('./utils');
const { state, addLinkGlobally } = require('./state');

(async () => {
    const { urlsToCrawl, terms, addedLinks: initialAddedLinks, cycleEndTime } = workerData;

    // Initialize worker state
    // We need to populate the globalLinks in the worker's state so addLinkGlobally works as expected (locally)
    // or we just use a local set and send updates.
    // The original code used 'workerAddedLinks' local set and also 'addLinkGlobally' which checked 'globalLinks'.
    // But 'globalLinks' in worker was empty/independent.
    // So 'addLinkGlobally' in worker only checked against what this worker had seen (if it added to it).
    // But 'addLinkGlobally' in main.js added to 'globalLinks'.
    // In worker, 'addLinkGlobally' added to worker's 'globalLinks'.
    // So effectively, it was a local check.

    // We will use a local set for this worker run.
    let workerAddedLinks = new Set(initialAddedLinks);

    // Also populate state.globalLinks if we want addLinkGlobally to work "locally" as before
    if (initialAddedLinks) {
        initialAddedLinks.forEach(link => state.globalLinks.add(link));
    }

    const results = {};
    for (const term of terms) results[term] = [];

    parentPort.postMessage({ type: 'started' });

    for (let url of urlsToCrawl) {
        if (Date.now() >= new Date(cycleEndTime).getTime() || state.stopFlag) {
            break;
        }

        try {
            const websiteResults = await crawlWebsite(url, terms, workerAddedLinks);
            for (const [term, articles] of Object.entries(websiteResults)) {
                if (!results[term]) results[term] = [];
                results[term].push(...articles);
                for (const article of articles) {
                    if (!workerAddedLinks.has(article.link)) {
                        workerAddedLinks.add(article.link);
                        // Update local state so subsequent checks in this worker fail
                        addLinkGlobally(article.link);
                        parentPort.postMessage({ type: 'addLinks', links: [article.link] });
                    }
                }
            }
        } catch (error) {
            if (state.stopFlag) break;
            parentPort.postMessage({
                type: 'error',
                error: new LightweightError(`Error processing ${url}: ${error.message}`)
            });
            continue;
        }

        if (state.stopFlag) break;

        parentPort.postMessage({
            type: 'progress',
            result: { articles: results }
        });
    }

    parentPort.postMessage({
        type: 'result',
        result: { articles: results }
    });
})();
