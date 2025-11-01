// Configuration for Repository Tracker
// GitHub API Integration (Optional)
// To enable GitHub API integration, set your token in localStorage:
// localStorage.setItem('github_token', 'your-token-here');
// 
// To get a GitHub token:
// 1. Go to GitHub Settings > Developer settings > Personal access tokens
// 2. Generate a new token with 'public_repo' scope
// 3. Store it securely in localStorage (or use environment variables in production)

const CONFIG = {
    // GitHub API settings
    githubAPI: {
        enabled: false, // Set to true to enable API fetching
        baseUrl: 'https://api.github.com',
        // Token should be stored in localStorage as 'github_token'
        // Rate limit: 60 requests/hour for unauthenticated, 5000/hour for authenticated
    },
    
    // Caching settings
    cache: {
        enabled: true,
        maxAge: 5 * 60 * 1000, // 5 minutes
    },
    
    // Pagination
    pagination: {
        defaultItemsPerPage: 25,
        options: [25, 50, 100, 0] // 0 means "show all"
    },
    
    // Features
    features: {
        darkMode: true,
        export: true,
        grouping: true,
        sorting: true,
        deepLinking: true,
        keyboardShortcuts: true,
    }
};

// Export for use in other scripts
if (typeof module !== 'undefined' && module.exports) {
    module.exports = CONFIG;
}

