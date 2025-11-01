# Contributing to Repository Ownership Tracker

Thank you for contributing to the Repository Ownership Tracker! This document provides guidelines for updating repository ownership data.

## Data Format

All repository data is stored in `data/repositories.json`. Each repository entry should follow this structure:

### Required Fields

- **organization**: GitHub organization name (e.g., "engineering", "product")
- **repository**: Repository name (e.g., "frontend-app")
- **pod**: Pod assignment (e.g., "Platform", "Backend", "Mobile")
- **vertical**: Vertical organization (e.g., "Engineering Infrastructure", "Product")
- **engineeringManager**: Full name of the Engineering Manager

### Optional Fields

- **description**: Brief description of the repository (recommended)
- **language**: Primary programming language (e.g., "TypeScript", "Go", "Python")
- **status**: Repository status - one of: `"active"`, `"archived"`, `"deprecated"` (defaults to "active")
- **lastActivity**: Last activity date in YYYY-MM-DD format
- **githubUrl**: Full GitHub URL (auto-generated as `https://github.com/{organization}/{repository}` if not provided)

### Metadata

The file should include a `metadata` object:

```json
{
  "metadata": {
    "lastUpdated": "2024-01-15T10:30:00Z",
    "version": "2.0",
    "source": "Manual entry"
  }
}
```

## Updating Repository Data

### Adding a New Repository

1. Open `data/repositories.json`
2. Add a new entry to the `repositories` array
3. Include all required fields
4. Add optional fields as available
5. Update the `metadata.lastUpdated` timestamp
6. Commit and push your changes

### Updating Existing Repository

1. Find the repository entry in `data/repositories.json`
2. Update the relevant fields (e.g., `engineeringManager`, `pod`, `status`)
3. Update the `metadata.lastUpdated` timestamp
4. Commit and push your changes

### Marking Repository as Archived

Set the `status` field to `"archived"`:

```json
{
  "organization": "engineering",
  "repository": "old-project",
  "status": "archived",
  ...
}
```

## Data Validation

Before committing, ensure:

- All required fields are present
- JSON syntax is valid (use a JSON validator if unsure)
- `lastUpdated` timestamp is current
- Status values are one of: "active", "archived", "deprecated"

## JSON Schema

A JSON Schema is available at `data/repository-schema.json` for validation. You can use online validators like:

- [JSON Schema Validator](https://www.jsonschemavalidator.net/)
- [JSONLint](https://jsonlint.com/)

## Best Practices

1. **Keep data current**: Update `lastUpdated` whenever you modify the data
2. **Be descriptive**: Include `description` and `language` when possible
3. **Track activity**: Update `lastActivity` when repositories become inactive
4. **Be consistent**: Use consistent naming for organizations, pods, and verticals
5. **Validate**: Check JSON syntax before committing

## Automated Updates

If you're setting up automated updates:

1. Use the JSON Schema for validation
2. Ensure timestamps are in ISO 8601 format
3. Handle missing optional fields gracefully
4. Preserve existing data structure

## Questions?

If you have questions about the data format or need help updating entries, please:

1. Check the [README.md](README.md) for general information
2. Review the JSON schema in `data/repository-schema.json`
3. Open an issue in the repository

Thank you for keeping the repository ownership data up to date!

