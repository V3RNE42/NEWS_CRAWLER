// Sample stopwords for testing
const { stopwordsEs, stopwordsEn } = require("./stopWords");
const sanitizeHtml = require('sanitize-html');

function filterWords(words, stopwords) {
    const result = [];
    for (let i = 0; i < words.length; i++) {
        const word = words[i];
        if (!stopwords.includes(word) && word.length > 2) {
            result.push(word);
        }
    }
    return result;
}

function getMainTopics(text, language) {
    if (language == 'ES') {
        text = text.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    }

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
    let threshold = Math.floor(totalWordCount * 0.1);
    let result = [];

    while (threshold > 0) {
        threshold -= sortedWords[0][1];
        result.push(sortedWords.shift());
    }

    result = result.map(word => word[0]);

    return result;
}

module.exports = {
    getMainTopics
};