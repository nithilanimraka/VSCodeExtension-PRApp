// In extension.ts or a separate auth.ts file
import * as vscode from 'vscode';

const GITHUB_AUTH_PROVIDER_ID = 'github';
// Define the scopes needed for your extension. Adjust as necessary.
// 'repo' scope is essential for accessing repository data, including PRs.
const SCOPES = ['repo', 'read:user'];

export async function getGitHubSession(): Promise<vscode.AuthenticationSession | undefined> {
    // The 'createIfNone' option will prompt the user to sign in if they aren't already
    try {
        const session = await vscode.authentication.getSession(GITHUB_AUTH_PROVIDER_ID, SCOPES, { createIfNone: true });
        if (session) {
            console.log('GitHub session obtained successfully.');
            return session;
        } else {
            vscode.window.showErrorMessage('Could not authenticate with GitHub.');
            return undefined;
        }
    } catch (err) {
        vscode.window.showErrorMessage(`GitHub Authentication failed: ${err}`);
        return undefined;
    }
}

export async function getOctokit(session?: vscode.AuthenticationSession) {
    if (!session) {
        session = await getGitHubSession();
    }

    if (session) {
        const { Octokit } = await import("@octokit/rest"); // Dynamic import
        return new Octokit({ auth: session.accessToken });
    } else {
        return undefined;
    }
}