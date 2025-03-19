const natural = require('natural');
const { WordTokenizer } = natural;

function getUniqueNGrams(words, n) {
    const ngrams = new Set();
    for (let i = 0; i <= words.length - n; i++) {
        ngrams.add(words.slice(i, i + n).join(' '));
    }
    return Array.from(ngrams);
}

function scorePhrases(phrases, wordFreq) {
    return phrases.map(phrase => {
        const words = phrase.split(' ');
        const score = words.reduce((sum, word) => sum + (wordFreq[word] || 0), 0) / words.length;
        return { phrase, score };
    });
}

function calculateTopicCount(tokenCount) {
    let e = 2.71828;
    return Math.max(5, Math.min(30, Math.floor(Math.log2(tokenCount) * e)));
}

function getMainTopics(text) {
    const tokenizer = new WordTokenizer();
    const words = tokenizer.tokenize(text);

    // Calculate dynamic topic count
    const topicCount = calculateTopicCount(words.length);

    // Calculate word frequencies
    const wordFreq = {};
    words.forEach(word => {
        if (word.length > 3) {
            wordFreq[word] = (wordFreq[word] || 0) + 1;
        }
    });

    // Get unique bigrams and trigrams
    const bigrams = getUniqueNGrams(words, 2);
    const trigrams = getUniqueNGrams(words, 3);

    // Score phrases
    const scoredBigrams = scorePhrases(bigrams, wordFreq);
    const scoredTrigrams = scorePhrases(trigrams, wordFreq);

    // Combine and sort all phrases
    const allPhrases = [...scoredBigrams, ...scoredTrigrams]
        .sort((a, b) => b.score - a.score);

    // Select top phrases, ensuring no word is repeated
    const topPhrases = [];
    const usedWords = new Set();
    for (const { phrase } of allPhrases) {
        const words = phrase.split(' ');
        if (!words.some(word => usedWords.has(word))) {
            topPhrases.push(phrase);
            words.forEach(word => usedWords.add(word));
            if (topPhrases.length === topicCount) break;
        }
    }

    return topPhrases;
}

/** Converts a given text into a vector based on a specified vocabulary using TF-IDF.
 * @param {string} text - The text to be vectorized.
 * @param {Array<string>} vocabulary - An array of words to be used for vectorization.
 * @return {Array<number>} A vector representing the TF-IDF values of the words in the vocabulary. */
function getTextVector(text, vocabulary) {
    const tfidf = new natural.TfIdf();
    tfidf.addDocument(text);
    return vocabulary.map(word => tfidf.tfidf(word, 0)); // Vectorize text
}

/** Calculates the cosine similarity between two vectors.
 * @param {Array<number>} vec1 - The first vector.
 * @param {Array<number>} vec2 - The second vector.
 * @return {number} The cosine similarity between the two vectors, ranging from -1 to 1.
 *         Returns 0 if either vector has zero magnitude. */
function cosineSimilarity(vec1, vec2) {
    const dotProduct = vec1.reduce((sum, val, i) => sum + val * vec2[i], 0);
    const magnitudeA = Math.sqrt(vec1.reduce((sum, val) => sum + val ** 2, 0));
    const magnitudeB = Math.sqrt(vec2.reduce((sum, val) => sum + val ** 2, 0));

    return magnitudeA && magnitudeB ? dotProduct / (magnitudeA * magnitudeB) : 0;
}

/** Checks if two texts are covering the same event by comparing their TF-IDF vectors.
 * @param {string} text1 - The first text to compare.
 * @param {string} text2 - The second text to compare.
 * @param {number} [threshold] - The cosine similarity threshold above which the two texts are considered to cover the same event.
 * @return {boolean} True if the texts are covering the same event, false otherwise. */
function bothCoveringSameEvent(text1, text2, threshold = 0.9) {
    const words1 = text1.split(/\W+/);
    const words2 = text2.split(/\W+/);
    const vocabulary = Array.from(new Set([...words1, ...words2]));

    const vec1 = getTextVector(text1, vocabulary);
    const vec2 = getTextVector(text2, vocabulary);

    return threshold <= cosineSimilarity(vec1, vec2);
}

module.exports = {
    getMainTopics, 
    bothCoveringSameEvent
};