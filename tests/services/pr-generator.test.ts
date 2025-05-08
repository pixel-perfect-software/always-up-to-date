import { createPullRequest } from "../../src/services/pr-generator";
import { mockGitHubAPI } from "../mocks/github-api";

describe("PR Generator Service", () => {
  let originalGitHubAPI;

  beforeEach(() => {
    originalGitHubAPI = global.gitHubAPI;
    global.gitHubAPI = mockGitHubAPI;
  });

  afterEach(() => {
    global.gitHubAPI = originalGitHubAPI;
  });

  test("should create a pull request with correct title and body", async () => {
    const title = "Update dependencies";
    const body = "This PR updates the following dependencies:\n- package1\n- package2\n\nMigration instructions:\n- Follow the upgrade guide for package1.\n- No changes needed for package2.";
    
    const result = await createPullRequest(title, body);
    
    expect(result).toEqual({
      success: true,
      url: "https://github.com/user/repo/pull/1",
    });
    expect(mockGitHubAPI.createPullRequest).toHaveBeenCalledWith({
      title,
      body,
      head: "branch-name",
      base: "main",
    });
  });

  test("should handle errors when creating a pull request", async () => {
    mockGitHubAPI.createPullRequest.mockRejectedValue(new Error("Failed to create PR"));

    await expect(createPullRequest("Error PR", "This will fail")).rejects.toThrow("Failed to create PR");
  });
});