# Repository Ownership Tracker

A professional GitHub Pages site built with CoreUI to track repository ownership across your organization's pods, verticals, and engineering managers.

## Features

### Core Features
- 🔍 **Advanced Search**: Full-text search across all repository fields with debounced input (300ms)
- 📊 **Comprehensive Statistics**: Detailed breakdowns by organization, pod, vertical, manager, and cross-organization analytics
- 📱 **Responsive Design**: Works seamlessly on desktop, tablet, and mobile devices
- 🚀 **Auto-Deployment**: Automatically deploys via GitHub Actions on every push
- 🎨 **Professional UI**: Built with CoreUI for a modern, polished interface

### Advanced Features
- 🔄 **Sortable Columns**: Click any column header to sort (ascending/descending)
- 🔗 **GitHub Links**: Direct links to repositories on GitHub
- 🎯 **Advanced Filtering**: Multi-select dropdowns for organizations, pods, verticals, managers, and status
- 📤 **Export Functionality**: Export filtered results to CSV or JSON
- 🔗 **Deep Linking**: Share filtered views via URL parameters
- 📄 **Pagination**: Navigate large datasets with configurable items per page (25, 50, 100, or all)
- 📊 **Organization Grouping**: Toggle between table view and grouped-by-organization view
- 🌙 **Dark Mode**: Toggle dark/light theme with persistent preference
- ⚡ **Client-Side Caching**: Automatic caching with 5-minute TTL for faster loads
- ⌨️ **Keyboard Shortcuts**: Press `Ctrl/Cmd+F` to focus search
- 💾 **Data Validation**: Automatic JSON schema validation with error reporting
- 📅 **Metadata Support**: Track last updated timestamp, version, and data source
- 🏷️ **Repository Metadata**: Optional fields for description, language, status, and last activity
- 📈 **Statistics Caching**: Efficient stat calculation and rendering
- 🎨 **Skeleton Loading**: Beautiful loading states during data fetch
- 📋 **Empty States**: Helpful guidance when no results match filters

## Setup

1. **Enable GitHub Pages**:
   - Go to your repository Settings → Pages
   - Under "Source", select "GitHub Actions"

2. **Update Data**:
   - Edit `data/repositories.json` with your repository ownership information
   - Each entry should have:
     - `organization`: GitHub organization name
     - `repository`: Repository name
     - `pod`: Pod assignment
     - `vertical`: Vertical organization
     - `engineeringManager`: Engineering Manager name

3. **Deploy**:
   - Push your changes to the `main` or `master` branch
   - GitHub Actions will automatically build and deploy the site
   - Your site will be available at `https://<username>.github.io/<repository-name>`

## Data Format

The `data/repositories.json` file should follow this structure:

```json
{
  "metadata": {
    "lastUpdated": "2024-01-15T10:30:00Z",
    "version": "2.0",
    "source": "Manual entry"
  },
  "repositories": [
    {
      "organization": "org-name",
      "repository": "repository-name",
      "pod": "Pod Name",
      "vertical": "Vertical Name",
      "engineeringManager": "Manager Name",
      "description": "Optional: Repository description",
      "language": "Optional: Primary language (e.g., TypeScript, Go)",
      "status": "active",
      "lastActivity": "2024-01-15",
      "githubUrl": "Optional: Auto-generated if not provided"
    }
  ]
}
```

### Optional Fields

- **description**: Brief description of the repository
- **language**: Primary programming language
- **status**: One of `"active"`, `"archived"`, or `"deprecated"` (defaults to `"active"`)
- **lastActivity**: Last activity date in `YYYY-MM-DD` format
- **githubUrl**: Full GitHub URL (auto-generated as `https://github.com/{organization}/{repository}` if not provided)

## Pages

- **Repository Table** (`index.html`): Main searchable table with all repositories, advanced filtering, sorting, export, and grouping options
- **Statistics** (`stats.html`): Detailed statistics and breakdowns with cross-organization analytics
- **About** (`about.html`): Information about the site and how to use it

## Usage

### Keyboard Shortcuts

- `Ctrl/Cmd + F`: Focus search input

### View Modes

- **Table View**: Standard tabular view with sortable columns
- **Grouped View**: Repositories grouped by organization with collapsible sections

### Filtering

- **Quick Search**: Type in the search box to filter across all fields
- **Advanced Filters**: Use dropdown menus to filter by specific criteria
- **Quick Filter Badges**: Click badges to quickly filter by organization
- **Clear Filters**: Click "Clear All" badge to reset all filters

### Exporting

- **CSV Export**: Export filtered results as CSV (includes all repository data)
- **JSON Export**: Export filtered results as JSON (includes filter metadata)

### Dark Mode

Click the moon/sun icon in the header to toggle dark mode. Your preference is saved and persists across sessions.

## GitHub API Integration (Optional)

To enable GitHub API integration for enhanced metadata:

1. Generate a GitHub Personal Access Token:
   - Go to GitHub Settings → Developer settings → Personal access tokens
   - Create a token with `public_repo` scope

2. Enable in browser console:
   ```javascript
   localStorage.setItem('github_token', 'your-token-here');
   ```

3. Refresh the page. The site will fetch additional metadata like stars, forks, and issues from GitHub.

**Note**: GitHub API has rate limits (60/hour unauthenticated, 5000/hour authenticated). The site caches data to minimize API calls.

## File Structure

```
.
├── index.html              # Main repository table page
├── stats.html             # Statistics dashboard
├── about.html             # About page
├── data/
│   ├── repositories.json          # Main data file
│   ├── repositories-template.json # Template for new entries
│   └── repository-schema.json    # JSON schema for validation
├── js/
│   ├── repository-tracker.js     # Main JavaScript module
│   └── config.js                 # Configuration file
├── .github/
│   └── workflows/
│       └── deploy.yml            # GitHub Actions deployment
├── CONTRIBUTING.md              # Contribution guidelines
└── README.md                    # This file
```

## Data Validation

The repository includes a JSON schema (`data/repository-schema.json`) for validating data structure. Before committing changes, ensure your JSON is valid:

- Required fields: `organization`, `repository`, `pod`, `vertical`, `engineeringManager`
- Optional fields: `description`, `language`, `status`, `lastActivity`, `githubUrl`
- Status must be one of: `"active"`, `"archived"`, `"deprecated"`

Use online JSON validators or the schema validator:
- [JSONLint](https://jsonlint.com/)
- [JSON Schema Validator](https://www.jsonschemavalidator.net/)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for detailed guidelines on updating repository data.

## Technologies

- [CoreUI](https://coreui.io/) - Modern Bootstrap-based admin template
- GitHub Pages - Static site hosting
- GitHub Actions - Continuous deployment
- Vanilla JavaScript - No framework dependencies
- JSON Schema - Data validation

## Performance

- **Client-Side Caching**: 5-minute TTL reduces load times
- **Debounced Search**: 300ms debounce prevents excessive filtering
- **Virtual Pagination**: Efficient rendering for large datasets
- **Lazy Loading**: Background data refresh without blocking UI

## Browser Support

- Chrome (latest)
- Firefox (latest)
- Safari (latest)
- Edge (latest)

## License

MIT

## Changelog

### Version 2.0
- Added organization support across all features
- Implemented advanced filtering with multi-select
- Added sortable columns
- GitHub repository links
- Export functionality (CSV/JSON)
- Deep linking with URL state
- Pagination and grouping views
- Dark mode with persistence
- Client-side caching
- Data validation
- Repository metadata support
- Keyboard shortcuts
- Skeleton loading states
- Statistics enhancements
- GitHub API integration (optional)

