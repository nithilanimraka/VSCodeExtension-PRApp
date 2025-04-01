import * as vscode from 'vscode';
import { Octokit } from '@octokit/rest';

export class PrTreeDataProvider implements vscode.TreeDataProvider<PrItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<PrItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private octokit: Octokit) {}

  refresh(): void {
    console.log('PrTreeDataProvider refresh called');
    this._onDidChangeTreeData.fire(undefined);
    console.log('Event fired');
  }

  getTreeItem(element: PrItem): vscode.TreeItem {
    return element;
  }

  async getChildren(): Promise<PrItem[]> {
    console.log('getChildren called');
    const config = vscode.workspace.getConfiguration('githubPRs');
    const repo = config.get<string>('repo')?.split('/');
    
    console.log('Repo config:', repo);
    
    if (!repo || repo.length !== 2) {
        console.log('Invalid repository format');
        vscode.window.showErrorMessage('Invalid repository format. Use owner/repo');
        return [];
    }

    try {
        console.log(`Fetching PRs for ${repo[0]}/${repo[1]}`);
        const { data: pulls } = await this.octokit.pulls.list({
            owner: repo[0],
            repo: repo[1],
            state: 'open'
        });

        console.log(`Found ${pulls.length} PRs`);
        return pulls.map(pr => new PrItem(
            `#${pr.number}: ${pr.title}`,
            pr.html_url,
            vscode.TreeItemCollapsibleState.None
        ));
    } catch (error) {
        console.error('Failed to fetch PRs:', error);
        const errorMessage = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(`Failed to fetch pull requests: ${errorMessage}`);
        return [];
    }
  }
}

class PrItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    private url: string,
    collapsibleState: vscode.TreeItemCollapsibleState
  ) {
    super(label, collapsibleState);
    this.tooltip = url;
    this.command = {
      command: 'vscode.open',
      title: 'Open PR',
      arguments: [vscode.Uri.parse(url)]
    };
  }
}