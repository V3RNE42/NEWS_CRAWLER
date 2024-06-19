const natural = require('natural');
const TfIdf = natural.TfIdf;
const { filterWords } = require("./topics_extractor");
const sanitizeHtml = require('sanitize-html');
const { stopWordsEn, stopwordsEs } = require("./stopWords");

function preprocessText(text, stopWords) {
    text = sanitizeHtml(text, { allowedTags: [], allowedAttributes: {} });
    return filterWords(text, stopWords);
}


function calculateSimilarity(text1, text2) {
    const tfidf = new TfIdf();

    tfidf.addDocument(text1);
    tfidf.addDocument(text2);

    const vector1 = [];
    const vector2 = [];

    tfidf.tfidfs(text1, function (i, measure) {
        vector1.push(measure);
    });

    tfidf.tfidfs(text2, function (i, measure) {
        vector2.push(measure);
    });

    const dotProduct = vector1.reduce((sum, value, index) => sum + value * vector2[index], 0);
    const norm1 = Math.sqrt(vector1.reduce((sum, value) => sum + value * value, 0));
    const norm2 = Math.sqrt(vector2.reduce((sum, value) => sum + value * value, 0));

    return dotProduct / (norm1 * norm2);
}

/**
 * Checks if two pieces of text are covering the same news by comparing their embeddings.
 *
 * @param {string} text1 - The first piece of text to compare.
 * @param {string} text2 - The second piece of text to compare.
 * @param {string} spokenLanguage - The spoken language of the texts.
 * @param {number} [similarityTreshold=0.85] - The threshold for similarity score - decimal from 0 (minimum) to 1 (maximum)
 * @return {Promise<boolean>} A promise that resolves to true if the similarity score is greater than or equal to the similarity threshold, false otherwise. */
async function coveringSameNews(text1, text2, spokenLanguage, similarityTreshold = 0.85) {
    const stopwords = spokenLanguage == "ES" ? stopwordsEs : stopWordsEn;

    const processedText1 = preprocessText(text1, stopwords);
    const processedText2 = preprocessText(text2, stopwords);

    const similarityScore = calculateSimilarity(processedText1, processedText2);

    return similarityScore >= similarityTreshold;
}

module.exports = {
    coveringSameNews
};
