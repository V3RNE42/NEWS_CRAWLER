const use = require('@tensorflow-models/universal-sentence-encoder');
const tf = require('@tensorflow/tfjs-node');
const { filterWords } = require("./topics_extractor");
const sanitizeHtml = require('sanitize-html');
const { stopWordsEn, stopwordsEs } = require("./stopWords");

async function loadModel() {
    if (!global.model) {
        global.model = await use.load();
    }
    return global.model;
}

function preprocessText(text, stopWords) {
    text = sanitizeHtml(text, { allowedTags: [], allowedAttributes: {} });
    return filterWords(text, stopWords);
}

async function getEmbeddings(model, text) {
    const embeddings = await model.embed(text);
    return embeddings;
}

function calculateSimilarity(embedding1, embedding2) {
    const dotProduct = tf.tidy(() => tf.dot(embedding1, embedding2).dataSync());
    const norm1 = tf.norm(embedding1).dataSync();
    const norm2 = tf.norm(embedding2).dataSync();
    const similarity = dotProduct / (norm1 * norm2);
    return similarity;
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
    const model = await loadModel();
    const stopwords = spokenLanguage == "ES" ? stopwordsEs : stopWordsEn;

    const processedText1 = preprocessText(text1, stopwords);
    const processedText2 = preprocessText(text2, stopwords);

    const embeddings = await getEmbeddings(model, [processedText1, processedText2]);
    const embedding1 = embeddings.gather(0);
    const embedding2 = embeddings.gather(1);

    const similarityScore = calculateSimilarity(embedding1, embedding2);

    return similarityScore >= similarityTreshold;
}

module.exports = {
    coveringSameNews
};
