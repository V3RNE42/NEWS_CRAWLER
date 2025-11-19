const state = {
    stopFlag: false,
    globalLinks: new Set()
};

const addLinkGlobally = (link) => {
    if (state.globalLinks.has(link)) return false;
    state.globalLinks.add(link);
    return true;
};

const resetGlobalLinks = () => {
    state.globalLinks = new Set();
};

module.exports = {
    state,
    addLinkGlobally,
    resetGlobalLinks
};
