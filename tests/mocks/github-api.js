"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.mockGitHubAPI = exports.Octokit = void 0;
// Mock implementation of @octokit/rest for testing
class Octokit {
    constructor(options) {
        this.rest = {
            pulls: {
                create: jest.fn().mockResolvedValue({
                    data: {
                        id: 123,
                        number: 1,
                        html_url: "https://github.com/test/repo/pull/1",
                        title: "Test PR",
                        body: "Test PR body",
                    },
                }),
            },
            repos: {
                get: jest.fn().mockResolvedValue({
                    data: {
                        id: 456,
                        name: "test-repo",
                        full_name: "test/repo",
                    },
                }),
            },
        };
        // Mock constructor
    }
}
exports.Octokit = Octokit;
exports.mockGitHubAPI = {
    createPullRequest: jest.fn().mockResolvedValue({
        id: 123,
        number: 1,
        html_url: "https://github.com/test/repo/pull/1",
    }),
    reset: () => {
        jest.clearAllMocks();
    },
};
