# Always Up To Date

## Overview
Always Up To Date is a highly customizable and reusable dependency checker for Node.js projects. It helps keep your npm dependencies up to date by automatically checking for updates, bumping versions, and generating pull requests when necessary. The tool also provides manual commands for checking dependencies and auditing for vulnerabilities.

## Features
- **Automatic Dependency Updates**: Runs daily checks against your project to update dependencies without breaking changes. If breaking changes are detected, it creates a pull request with migration instructions.
- **Manual Dependency Check**: Allows users to manually check for dependencies that can be updated.
- **Dependency Audit**: Scans for vulnerabilities in your project's dependencies.

## Installation
To install Always Up To Date, run the following command in your project directory:

```bash
npm install always-up-to-date
```

## Usage
After installation, you can use the command line interface to interact with the tool. Here are some common commands:

### Check for Updates
To check for dependencies that can be updated, run:

```bash
npx alwaysuptodate --mode=check
```

### Audit Dependencies
To audit your dependencies for vulnerabilities, use:

```bash
npx alwaysuptodate --mode=audit
```

### Automatic Updates
To enable automatic updates, run:

```bash
npx alwaysuptodate --mode=auto
```

## Contributing
Contributions are welcome! Please follow these steps to contribute to the project:

1. Fork the repository.
2. Create a new branch for your feature or bug fix.
3. Make your changes and commit them.
4. Push your branch to your forked repository.
5. Create a pull request describing your changes.

## License
This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.

## Acknowledgments
Thanks to all contributors and the open-source community for their support and inspiration in building this project.