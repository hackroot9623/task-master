import {Editor, MarkdownPreviewView, MarkdownView, Notice, Plugin, Modal, Menu, SuggestModal, App} from 'obsidian';
import type {EmojiChecklistSettings} from './types';
import {DEFAULT_SETTINGS} from './types';
import {EmojiChecklistSettingTab} from './settings';
import {processCheckboxes} from './processor';
import {JiraClient} from './jira';
import {JiraTaskSuggester} from './suggester';
import {GitIntegration} from './git';
import {GitMergeRequestSuggester, GitMergeRequest} from './gitSuggester';

// Augment the MarkdownView type from Obsidian
declare module 'obsidian' {
    interface MarkdownView {
        previewMode: MarkdownPreviewView;
        editor: Editor;
    }
}   

export default class EmojiChecklistPlugin extends Plugin {
    settings: EmojiChecklistSettings;

    async onload() {
        await this.loadSettings();
        console.log('Plugin loaded with settings:', this.settings);

        // Register editor change handler for @ triggers
        this.registerEvent(
            this.app.workspace.on('editor-change', (editor: Editor) => {
                const cursor = editor.getCursor();
                const line = editor.getLine(cursor.line);
                const beforeCursor = line.slice(0, cursor.ch);

                // Check if we just typed the trigger word
                const triggerWord = this.settings.jiraSettings.triggerWord;
                console.log('Checking for trigger:', {
                    triggerWord,
                    beforeCursor,
                    endsWith: beforeCursor.endsWith(triggerWord),
                    enabled: this.settings.jiraSettings.enabled
                });

                if (beforeCursor.endsWith(triggerWord)) {
                    console.log('Trigger word detected, handling Jira trigger');
                    this.handleJiraTrigger(editor);
                }
            })
        );

        // Add command to insert Jira issue
        this.addCommand({
            id: 'insert-jira-issue',
            name: 'Insert Jira Issue',
            checkCallback: (checking: boolean) => {
                const view = this.app.workspace.getActiveViewOfType(MarkdownView);
                if (!view) return false;
                if (!checking) {
                    this.insertJiraIssue(view);
                }
                return true;
            }
        });

        this.registerMarkdownPostProcessor(processCheckboxes.bind(this));
        this.addSettingTab(new EmojiChecklistSettingTab(this.app, this));

        // Register the editor menu command
        this.registerEvent(
            this.app.workspace.on('editor-menu', (menu, editor) => {
                if (editor.getSelection()) {
                    menu.addItem((item) => {
                        item
                            .setTitle('Copy as Formatted Report')
                            .setIcon('clipboard-copy')
                            .onClick(() => this.formatAndCopyToClipboard(editor));
                    });
                }
            })
        );

        // Add Git integration commands
        this.addCommand({
            id: 'view-github-prs',
            name: 'View GitHub Pull Requests',
            checkCallback: (checking: boolean) => {
                if (!this.settings.gitSettings.githubToken) return false;
                if (!checking) {
                    this.viewGitHubPRs();
                }
                return true;
            }
        });

        this.addCommand({
            id: 'view-gitlab-mrs',
            name: 'View GitLab Merge Requests',
            checkCallback: (checking: boolean) => {
                if (!this.settings.gitSettings.gitlabToken || !this.settings.gitSettings.gitlabUrl) return false;
                if (!checking) {
                    this.viewGitLabMRs();
                }
                return true;
            }
        });

        // Add Git menu to the editor context menu
        this.registerEvent(
            this.app.workspace.on('editor-menu', (menu, editor) => {
                menu.addItem((item) => {
                    item
                        .setTitle('Git Integration')
                        .setIcon('git-pull-request')
                        .onClick(() => {
                            const gitMenu = new Modal(this.app);
                            
                            if (this.settings.gitSettings.githubToken) {
                                gitMenu.contentEl.createEl('button', {
                                    text: 'View GitHub Pull Requests',
                                    cls: 'git-result-item',
                                    attr: { 'data-url': 'github' }
                                }).addEventListener('click', () => {
                                    this.viewGitHubPRs();
                                });
                            }
                            
                            if (this.settings.gitSettings.gitlabToken && this.settings.gitSettings.gitlabUrl) {
                                gitMenu.contentEl.createEl('button', {
                                    text: 'View GitLab Merge Requests',
                                    cls: 'git-result-item',
                                    attr: { 'data-url': 'gitlab' }
                                }).addEventListener('click', () => {
                                    this.viewGitLabMRs();
                                });
                            }
                            
                            gitMenu.open();
                        });
                });
            })
        );
    }

    private formatAndCopyToClipboard(editor: Editor) {
        const selectedText = editor.getSelection();
        if (!selectedText) {
            new Notice('No text selected');
            return;
        }

        if (!this.settings.reportSettings.enabled) {
            new Notice('Report feature is disabled in settings');
            return;
        }

        // Helper function to get the appropriate emoji based on tag and checked status
        const getEmoji = (line: string, isChecked: boolean): string => {
            for (const mapping of this.settings.tagMappings) {
                if (line.toLowerCase().includes(`#${mapping.tag.toLowerCase()}`)) {
                    return isChecked ? mapping.checkedEmoji : mapping.uncheckedEmoji;
                }
            }
            return isChecked ? this.settings.checkedEmoji : this.settings.uncheckedEmoji;
        };

        // Parse the selected text to find tasks and stoppers
        const lines = selectedText.split('\n');
        const processLine = (line: string) => {
            line = line.trim();
            if (line.startsWith('- [x]')) {
                return line.replace('- [x]', getEmoji(line, true));
            } else if (line.startsWith('- [ ]')) {
                return line.replace('- [ ]', getEmoji(line, false));
            }
            return line;
        };

        const tasks = lines
            .filter(line => line.trim().length > 0)
            .map(processLine);

        const stoppers = lines
            .filter(line => line.toLowerCase().includes('#stopper'))
            .map(processLine);

        // Get today's date
        const today = new Date().toLocaleDateString('en-US', { 
            weekday: 'long',
            year: 'numeric',
            month: 'long',
            day: 'numeric'
        });

        // Build the content based on enabled sections
        const contentParts: string[] = [];

        for (const section of this.settings.reportSettings.sections) {
            if (!section.enabled) continue;

            // Add section header if enabled
            if (this.settings.reportSettings.showHeaders && section.showHeader) {
                contentParts.push(`### ${section.name}`);
            }

            // Add section content
            let sectionContent = section.content;
            switch (section.name) {
                case 'DATE':
                    sectionContent = `📅 ${today}`;
                    break;
                case 'BODY':
                    sectionContent = tasks
                        .filter(task => !task.toLowerCase().includes('#stopper'))
                        .join('\n');
                    break;
                case 'STOPPERS':
                    sectionContent = stoppers.join('\n');
                    break;
            }

            if (sectionContent) {
                contentParts.push(sectionContent);
                contentParts.push(''); // Add empty line after section
            }
        }

        const formattedContent = contentParts.join('\n');

        // Copy to clipboard
        navigator.clipboard.writeText(formattedContent)
            .then(() => {
                new Notice('Formatted content copied to clipboard');
            })
            .catch(() => {
                new Notice('Failed to copy to clipboard');
            });
    }

    private async insertJiraIssue(view: MarkdownView) {
        if (!this.settings.jiraSettings.enabled) {
            new Notice('Please enable and configure Jira integration in settings first');
            return;
        }

        try {
            const jiraClient = new JiraClient(this.settings.jiraSettings);
            const tasks = await jiraClient.searchTasks('my tasks');

            if (tasks.length === 0) {
                new Notice('No Jira tasks found assigned to you');
                return;
            }

            new JiraTaskSuggester(this.app, tasks, (selectedTask) => {
                const cursor = view.editor.getCursor();
                const taskMarkdown = `- [ ] [${selectedTask.key}: ${selectedTask.summary}](${selectedTask.url}) (${selectedTask.status})`;

                // Insert at cursor position
                view.editor.replaceRange(
                    taskMarkdown + '\n',
                    cursor,
                    cursor
                );

                // Move cursor to next line
                view.editor.setCursor({
                    line: cursor.line + 1,
                    ch: 0
                });
            });
        } catch (error) {
            console.error('Error fetching Jira tasks:', error);
            new Notice(error.message || 'Error fetching Jira tasks');
        }
    }

    private async handleJiraTrigger(_editor: Editor) {
        console.log('handleJiraTrigger called');

        if (!this.settings.jiraSettings.enabled) {
            console.log('Jira integration not enabled');
            new Notice('Please enable and configure Jira integration in settings first');
            return;
        }

        try {
            console.log('Creating Jira client with settings:', this.settings.jiraSettings);
            const jiraClient = new JiraClient(this.settings.jiraSettings);

            console.log('Fetching tasks...');
            const tasks = await jiraClient.searchTasks('my tasks');
            console.log('Fetched tasks:', tasks);

            if (tasks.length === 0) {
                console.log('No tasks found');
                new Notice('No Jira tasks found assigned to you');
                return;
            }

            console.log('Opening task suggester with', tasks.length, 'tasks');

            // Ensure we're in the correct context
            const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
            if (!activeView) {
                console.error('No active markdown view');
                new Notice('Please open a markdown note first');
                return;
            }

            // Create suggester with more robust error handling
            try {
                const suggester = new JiraTaskSuggester(
                    this.app,
                    tasks,
                    (selectedTask) => {
                        console.log('Task selected:', selectedTask);
                        const editor = activeView.editor;
                        const cursor = editor.getCursor();
                        const triggerWord = this.settings.jiraSettings.triggerWord;
                        const currentLine = editor.getLine(cursor.line);

                        // Remove the trigger word and replace with the task
                        const newLine = currentLine.slice(0, cursor.ch - triggerWord.length) +
                                      `[${selectedTask.key}: ${selectedTask.summary}](${selectedTask.url}) (${selectedTask.status})` +
                                      currentLine.slice(cursor.ch);

                        // Replace the current line
                        editor.setLine(cursor.line, newLine);

                        // Move cursor to end of inserted text
                        editor.setCursor({
                            line: cursor.line,
                            ch: cursor.ch - triggerWord.length + `[${selectedTask.key}: ${selectedTask.summary}](${selectedTask.url}) (${selectedTask.status})`.length
                        });
                    }
                );

                // Additional logging to verify suggester creation
                console.log('Suggester created:', suggester);
            } catch (suggesterError) {
                console.error('Error creating suggester:', suggesterError);
                new Notice('Failed to create task suggester');
            }
        } catch (error) {
            console.error('Error in handleJiraTrigger:', error);
            new Notice(error.message || 'Error fetching Jira tasks');
        }
    }

    private async viewGitHubPRs() {
        try {
            const gitIntegration = new GitIntegration(this.settings.gitSettings);
            const prs = await gitIntegration.getAllGitHubPRs();
            if (!prs || prs.length === 0) {
                new Notice('No open pull requests found');
                return;
            }

            const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
            if (!activeView) {
                new Notice('No active markdown view');
                return;
            }

            new GitMergeRequestSuggester(
                this.app,
                document.createElement('input'),
                gitIntegration,
                prs,
                (selectedPR) => {
                    const editor = activeView.editor;
                    const linkText = `[${selectedPR.title}](${selectedPR.html_url || selectedPR.web_url})`;
                    editor.replaceSelection(linkText);
                    new Notice('Pull request link inserted');
                }
            );
        } catch (error) {
            new Notice('Error fetching GitHub PRs: ' + error.message);
            console.error('Error fetching GitHub PRs:', error);
        }
    }

    private async viewGitLabMRs() {
        try {
            const gitIntegration = new GitIntegration(this.settings.gitSettings);
            const mrs = await gitIntegration.getAllGitLabMRs();
            if (!mrs || mrs.length === 0) {
                new Notice('No open merge requests found');
                return;
            }

            const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
            if (!activeView) {
                new Notice('No active markdown view');
                return;
            }

            new GitMergeRequestSuggester(
                this.app,
                document.createElement('input'),
                gitIntegration,
                mrs,
                (selectedMR) => {
                    const editor = activeView.editor;
                    const linkText = `[${selectedMR.title}](${selectedMR.html_url || selectedMR.web_url})`;
                    editor.replaceSelection(linkText);
                    new Notice('Merge request link inserted');
                }
            );
        } catch (error) {
            new Notice('Error fetching GitLab MRs: ' + error.message);
            console.error('Error fetching GitLab MRs:', error);
        }
    }

    private async promptForRepository(type: 'github' | 'gitlab' = 'github'): Promise<string | null> {
        return new Promise((resolve) => {
            const gitIntegration = new GitIntegration(this.settings.gitSettings);
            const inputEl = document.createElement('input');
            inputEl.type = 'text';
            inputEl.placeholder = type === 'github' 
                ? "Search GitHub pull requests..." 
                : "Search GitLab merge requests...";

            new GitMergeRequestSuggester(
                this.app,
                inputEl,
                gitIntegration,
                undefined,
                (selectedPR: GitMergeRequest) => {
                    const repoUrl = selectedPR.web_url || selectedPR.html_url || '';
                    try {
                        const urlObj = new URL(repoUrl);
                        const pathParts = urlObj.pathname.split('/');
                        resolve(`${pathParts[1]}/${pathParts[2]}`);
                    } catch (error) {
                        console.error('Error extracting repo path:', error);
                        resolve(null);
                    }
                }
            );
        });
    }

    async loadSettings() {
        const loadedData = await this.loadData();
        console.log('Loaded data:', loadedData);
        this.settings = Object.assign({}, DEFAULT_SETTINGS, loadedData);
        console.log('Merged settings:', this.settings);
    }

    async saveSettings() {
        console.log('Saving settings:', this.settings);
        await this.saveData(this.settings);
    }

    refreshAllNotes() {
        // Force refresh all markdown views
        this.app.workspace.trigger('markdown-preview-refresh');

        // Force re-render of all leaf views
        this.app.workspace.iterateAllLeaves(leaf => {
            if (leaf.view.getViewType() === 'markdown') {
                (leaf.view as MarkdownView).previewMode?.rerender(true);
            }
        });

        new Notice('Applied emoji changes to all notes');
    }
}
