const { stopwordsEs, stopwordsEn } = require("./stopWords");
const sanitizeHtml = require('sanitize-html');

function filterWords(words, stopwords) {
    const stopwordsSet = new Set(stopwords);
    const result = [];
    for (let i = 0; i < words.length; i++) {
        const word = words[i];
        if (!stopwordsSet.has(word)) {
            result.push(word);
        }
    }
    return result;
}

/**
 * Extracts the main topics from a given text.
 *
 * @param {string} text - The text from which to extract the main topics.
 * @param {string} language - The language of the text. If 'ES', the text is normalized and special characters are removed.
 * @param {number} [sensitivity=5] - The sensitivity level for determining the main topics. Higher sensitivity means less false positives and more false negatives.
 * @return {string[]} An array of strings representing the main topics extracted from the text.     */
function getMainTopics(text, language, sensitivity = 5) {
    text = sanitizeHtml(text, { allowedTags: [], allowedAttributes: {} });
    text = text.toLowerCase();
    text = text.replace(/[^\w\s]/gi, '');
    const words = text.split(/\s+/);
    const filteredWords = filterWords(words, language == 'ES' ? stopwordsEs : stopwordsEn);
    
    const wordCount = {};
    for (let i = 0; i < filteredWords.length; i++) {
        const word = filteredWords[i];
        if (wordCount[word]) {
            wordCount[word]++;
        } else {
            wordCount[word] = 1;
        }
    }
    
    let sortedWords = Object.entries(wordCount).sort((a, b) => b[1] - a[1]);
    let totalWordCount = 0;
    for (let i = 0; i < sortedWords.length; i++) {
        totalWordCount += sortedWords[i][1];
    }
    let threshold = Math.floor(totalWordCount * (1/sensitivity));
    let result = [];

    while (threshold > 0) {
        threshold -= sortedWords[0][1];
        result.push(sortedWords.shift());
    }

    result = result.map(word => word[0]);

    return result;
}

module.exports = {
    getMainTopics,
    sanitizeHtml,
    filterWords
}