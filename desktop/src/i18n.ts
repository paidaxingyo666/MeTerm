export type Language = 'en' | 'zh';

export interface Translations {
  appName: string;
  settings: string;
  settingsTabAppearance: string;
  settingsTabTerminal: string;
  settingsTabGeneral: string;
  theme: string;
  opacity: string;
  enableVibrancy: string;
  fontSize: string;
  fontFamily: string;
  enableNerdFont: string;
  enableLigatures: string;
  enableBoldFont: string;
  encoding: string;
  fileManagerFontSize: string;
  previewRefreshRate: string;
  newTerminal: string;
  noSessions: string;
  newSessionHint: string;
  connecting: string;
  connected: string;
  reconnecting: string;
  ended: string;
  sessionNotFound: string;
  disconnected: string;
  reconnect: string;
  active: string;
  language: string;
  closeSession: string;
  contextMenuNewTerminal: string;
  contextMenuHome: string;
  contextMenuSettings: string;
  contextMenuCloseSession: string;
  contextMenuCopy: string;
  contextMenuPaste: string;
  responseSession: string;
  hideToTrayTipTitle: string;
  hideToTrayTipBody: string;
  hideToTrayTipDontShow: string;
  hideToTrayTipOk: string;
  hideToTrayTipHideNow: string;
  hideToTrayTipCancel: string;
  hideToTrayTipRemember: string;
  confirmQuitWithSessions: string;
  confirmCloseAllSessions: string;
  confirmCloseWindowWithSessions: string;
  confirmQuitAllWindows: string;
  confirmHideToTrayWithSessions: string;
  aboutDialogTitle: string;
  aboutDialogBody: string;
  shortcutsDialogTitle: string;
  shortcutsDialogBody: string;
  shortcutNewTerminal: string;
  shortcutCloseSession: string;
  shortcutClearTerminal: string;
  shortcutClearInput: string;
  shortcutOpenSettings: string;
  shortcutSplitHorizontal: string;
  shortcutSplitVertical: string;
  shortcutNavigatePanes: string;
  shortcutSwitchToTab: string;
  shortcutNextTab: string;
  shortcutPrevTab: string;
  colorScheme: string;
  colorSchemeAuto: string;
  colorSchemeDark: string;
  colorSchemeDarker: string;
  colorSchemeNavy: string;
  colorSchemeLight: string;
  rememberWindowSize: string;
  rememberDrawerLayout: string;
  pipScale: string;
  pipScaleByScreen: string;
  sessionsGallery: string;
  sshConnect: string;
  sshHost: string;
  sshPort: string;
  sshUsername: string;
  sshAuthMethod: string;
  sshPassword: string;
  sshPrivateKey: string;
  sshConnectBtn: string;
  sshDisconnect: string;
  sshConnecting: string;
  sshConnected: string;
  sshFailed: string;
  sshAuthPassword: string;
  sshAuthKey: string;
  sshSavedConnections: string;
  sshNoSavedConnections: string;
  sshQuickConnect: string;
  sshNewConnection: string;
  sshDeleteConnection: string;
  sshConnectionName: string;
  sshSaveConnection: string;
  sshTestConnection: string;
  sshTestSuccess: string;
  sshTestFailed: string;
  sshTesting: string;
  sshConnectAndSave: string;
  sshUnsavedConfirm: string;
  sshUnsavedDiscard: string;
  sshUnsavedCancel: string;
  sshAuthFailedTitle: string;
  sshAuthFailedMsg: string;
  sshAuthFailedRetry: string;
  sshPasswordUpdated: string;
  drawerTabFiles: string;
  drawerTabProcesses: string;
  serverInfoHost: string;
  serverInfoUser: string;
  serverInfoOS: string;
  serverInfoKernel: string;
  serverInfoUptime: string;
  serverInfoCPU: string;
  serverInfoMemory: string;
  serverInfoDisk: string;
  serverInfoNetwork: string;
  serverInfoLoading: string;
  processColPID: string;
  processColName: string;
  processColUser: string;
  processColCPU: string;
  processColMem: string;
  processColTime: string;
  backgroundImage: string;
  backgroundImageOpacity: string;
  backgroundImageSelect: string;
  backgroundImageClear: string;
  homeNewLocalSession: string;
  homeNewSSHSession: string;
  noShellsFound: string;
  defaultShell: string;
  defaultShellSetting: string;
  contextMenuIntegration: string;
  systemDefault: string;
  homeSavedConnections: string;
  homeEditConnection: string;
  homeShowMore: string;
  homeShowLess: string;
  homeRecentConnections: string;
  aiCapsule: string;
  aiBarOpacity: string;
  aiSendCommand: string;
  aiSendPrompt: string;
  aiModelSelect: string;
  aiPlaceholderInput: string;
  aiPlaceholderCmd: string;
  aiPlaceholderAgent: string;
  aiCollapse: string;
  aiExpand: string;
  aiHistory: string;
  aiHistoryEmpty: string;
  aiSearchHistory: string;
  aiSearchChatHistory: string;
  aiSourceManual: string;
  aiTimeJustNow: string;
  aiCopyCommand: string;
  settingsTabAI: string;
  aiProvider: string;
  aiPreset: string;
  aiApiKey: string;
  aiBaseUrl: string;
  aiModelName: string;
  aiTemperature: string;
  aiMaxTokens: string;
  aiContextLines: string;
  aiAgentTrustLevel: string;
  aiAgentTrustManual: string;
  aiAgentTrustSemiAuto: string;
  aiAgentTrustFullAuto: string;
  aiAgentMaxIterations: string;
  aiAgentUnlimited: string;
  aiTestConnection: string;
  aiTestSuccess: string;
  aiTestFailed: string;
  aiTesting: string;
  aiNewChat: string;
  aiClearChat: string;
  aiRunCommand: string;
  aiCopyCode: string;
  aiDangerConfirmTitle: string;
  aiDangerConfirmMsg: string;
  aiDangerConfirmRun: string;
  aiDangerConfirmCancel: string;
  aiNoConfig: string;
  aiStreamError: string;
  aiRateLimitRetry: string;
  aiServerErrorRetry: string;
  aiContextCompressed: string;
  aiThinking: string;
  aiWorking: string;
  aiStopGenerating: string;
  aiCtxCopy: string;
  aiCtxCopyResult: string;
  aiCtxResend: string;
  aiCtxDelete: string;
  aiModelAuto: string;
  aiModelAutoDesc: string;
  aiAddProvider: string;
  aiDeleteProvider: string;
  aiProviderProtocol: string;
  aiFetchModels: string;
  aiFetching: string;
  aiFetchSuccess: string;
  aiFetchFailed: string;
  aiNoModels: string;
  aiModelsCount: string;
  aiSelectModels: string;
  aiProviderLabel: string;
  aiCustomProvider: string;
  aiSearxng: string;
  aiSearxngUrl: string;
  aiSearxngUrlPlaceholder: string;
  aiSearxngUsername: string;
  aiSearxngPassword: string;
  aiSearxngEnable: string;
  aiSearxngTest: string;
  aiSearxngTestOk: string;
  aiSearxngTestFail: string;
  tabMenuCloseTab: string;
  tabMenuCloseOthers: string;
  tabMenuCloseLeft: string;
  tabMenuCloseRight: string;
  tabMenuCloseAll: string;
  tabMenuCopyTitle: string;
  tabMenuCloneTab: string;
  splitHorizontal: string;
  splitVertical: string;
  closePane: string;
  pairingTitle: string;
  pairingSubtitle: string;
  pairingDeviceName: string;
  pairingAddress: string;
  pairingCopyData: string;
  pairingCopied: string;
  pairingClose: string;
  homeMobilePairing: string;
  masterRequestTitle: string;
  masterRequestMessage: string;
  masterRequestApprove: string;
  masterRequestDeny: string;
  reclaimControl: string;
  reclaimClickHint: string;
  reclaimSpaceHint: string;
  shareLink: string;
  shareLinkCopied: string;
  settingsTabSharing: string;
  settingsTabAbout: string;
  aboutVersion: string;
  aboutDescription: string;
  aboutGitHub: string;
  aboutGitee: string;
  aboutLicense: string;
  aboutCopyright: string;
  aboutCheckUpdate: string;
  aboutOpenSource: string;
  aboutLicenses: string;
  aboutAckXterm: string;
  aboutAckTauri: string;
  aboutAckConpty: string;
  aboutAckJumpserver: string;
  aboutAckTldr: string;
  aboutAckSearxng: string;
  aboutAckCodemirror: string;
  sshExportConnections: string;
  sshImportConnections: string;
  sshExportSuccess: string;
  sshImportSuccess: string;
  sshImportFailed: string;
  sshImportInvalidFormat: string;
  sshImportCount: string;
  sshExportCount: string;
  sshNoConnectionsToExport: string;
  homeRemoteConnect: string;
  remoteConnectTitle: string;
  remoteConnectSubtitle: string;
  remoteTabUrl: string;
  remoteTabJson: string;
  remoteTabScan: string;
  remoteUrlPlaceholder: string;
  remoteJsonPlaceholder: string;
  remoteConnectBtn: string;
  remoteConnecting: string;
  remoteConnected: string;
  remoteFailed: string;
  remoteInvalidUrl: string;
  remoteInvalidJson: string;
  remoteScanComingSoon: string;
  remoteSelectSession: string;
  remoteNoSessions: string;
  remoteViewerMode: string;
  remoteTokenLabel: string;
  remoteTokenPlaceholder: string;
  remoteSessionList: string;
  remoteSessionRefresh: string;
  remoteSessionAutoRefresh: string;
  remoteSessionServer: string;
  remoteSessionNoRemote: string;
  remoteSessionOpened: string;
  viewerRequestControl: string;
  viewerRequesting: string;
  viewerRequestDenied: string;
  viewerObserving: string;
  remoteEditTitle: string;
  remoteSaveBtn: string;
  remoteConnectionName: string;
  remoteHost: string;
  remotePort: string;
  remoteToken: string;
  remoteSavedToHome: string;
  remoteSaveConnection: string;
  remoteDeleteConnection: string;
  sshHostKeyUnknownTitle: string;
  sshHostKeyUnknownMsg: string;
  sshHostKeyType: string;
  sshHostKeyFingerprint: string;
  sshHostKeyTrust: string;
  sshHostKeyMismatchMsg: string;
  remotePairRequest: string;
  remotePairing: string;
  remotePairApproved: string;
  remotePairDenied: string;
  remotePairTimeout: string;
  remotePairCancel: string;
  pairApprovalTitle: string;
  pairApprovalMessage: string;
  pairApprovalDevice: string;
  pairApprovalAddress: string;
  pairApprovalApprove: string;
  pairApprovalDeny: string;
  remoteAddressLabel: string;
  remoteScanBtn: string;
  remoteScanStop: string;
  remoteScanScanning: string;
  remoteScanFound: string;
  remoteScanEmpty: string;
  remoteScanVerifying: string;
  remoteScanVerified: string;
  remoteScanUnreachable: string;
  remoteScanConnect: string;
  remoteScanNoLocalServer: string;
  remoteScanError: string;
  settingsDiscoverable: string;
  connectedDevices: string;
  kickClient: string;
  kickAndBan: string;
  ipBanList: string;
  unbanIp: string;
  noConnectedDevices: string;
  noBannedIps: string;
  tokenManagement: string;
  currentToken: string;
  refreshToken: string;
  tokenRefreshed: string;
  customToken: string;
  customTokenPlaceholder: string;
  customTokenTooShort: string;
  setToken: string;
  revokeAllClients: string;
  confirmRevokeAll: string;
  tokenSetSuccess: string;
  revokeSuccess: string;
  kickSuccess: string;
  deviceCardSessions: string;
  devicePairedIdle: string;
  deviceCardKickDevice: string;
  kickDeviceConfirm: string;
  kickDeviceSuccess: string;
  tabMenuLockSession: string;
  tabMenuUnlockSession: string;
  lockSessionConfirm: string;
  sessionPrivate: string;
  newPrivateTerminal: string;
  kickedByHost: string;
  kickedOverlayMsg: string;
  closeTab: string;
  confirmBanIp: string;
  banIpYes: string;
  banIpSkip: string;
  confirmKickClient: string;
  confirmLockAfterKick: string;
  sessionPrivateCannotConnect: string;
  remoteSessionClosed: string;
  enableTerminalNotifications: string;
  banDevice: string;
  banDeviceConfirm: string;
  remoteTypeBadge: string;
  remoteScanLan: string;
  remoteRescan: string;
  aiChatHistory: string;
  aiChatHistoryEmpty: string;
  aiChatHistoryTitle: string;
  aiChatDeleteConfirmTitle: string;
  aiChatDeleteConfirmMsg: string;
  aiChatDeleteConfirmOk: string;
  aiChatDeleteConfirmCancel: string;
  aiChatDeleteNoAskMinutes: string;
  aiChatHistoryBack: string;
  updateAvailable: string;
  updateNow: string;
  updateLater: string;
  updateDownloading: string;
  updateFinishing: string;
  updateRestarting: string;
  updateHint: string;
  updateFailed: string;
  updateFailedHint: string;
  updateModalTitle: string;
  updateReleaseNotes: string;
  checkUpdates: string;
  checkUpdatesUpToDate: string;
  checkUpdatesChecking: string;
  updateModalClose: string;
  hideUpdateIcon: string;
  openFileManager: string;
  navigateConfirmMsg: string;
  navigateCancel: string;
  navigateConfirm: string;
  fileLinkHint: string;
  fileLinkOpenLocal: string;
  fileLinkOpenInDrawer: string;
  fileLinkDontAskAgain: string;
  fileLinkLocalConfirmMsg: string;
  fileLinkConfirmOpen: string;
  fileLinkSkipConfirmSetting: string;
  autoNewSession: string;
  // tldr & command completion
  tldrHelp: string;
  tldrEnable: string;
  tldrNoData: string;
  tldrUpdating: string;
  tldrLastUpdated: string;
  tldrUpdateNow: string;
  tldrPageCount: string;
  tldrExamples: string;
  cmdCompletionEnable: string;
  cmdCompletionHint: string;
  cmdCompletionHistoryHint: string;
  // Shell hook injection
  shellHookInjection: string;
  shellHookEnable: string;
  shellHookHint: string;
  // JumpServer
  jsEditServer: string;
  jsAddServer: string;
  jsName: string;
  jsBaseUrl: string;
  jsSshHost: string;
  jsSshHostPlaceholder: string;
  jsAuthMethod: string;
  jsAuthPassword: string;
  jsAuthToken: string;
  jsApiToken: string;
  jsOrgId: string;
  jsOrgIdPlaceholder: string;
  jsTestConnection: string;
  jsTesting: string;
  jsTestSuccess: string;
  jsTestFailed: string;
  jsSave: string;
  jsFieldsRequired: string;
  jsInvalidUrl: string;
  jsMfaTitle: string;
  jsMfaDesc: string;
  jsMfaCodePlaceholder: string;
  jsMfaVerify: string;
  jsAssetBrowser: string;
  jsSearchAssets: string;
  jsLoading: string;
  jsAllAssets: string;
  jsAssetsTotal: string;
  jsNoAssets: string;
  jsAssetName: string;
  jsAssetAddress: string;
  jsAssetPlatform: string;
  jsAssetComment: string;
  jsAssetProtocols: string;
  jsAssetActions: string;
  jsConnect: string;
  jsLoadingAccounts: string;
  jsNoAccounts: string;
  jsSelectAccount: string;
  homeNewJumpServer: string;
  jsSaveAndConnect: string;
  homeSearchPlaceholder: string;
  homeGroupDefault: string;
  homeGroupUngrouped: string;
  homeGroupManage: string;
  homeGroupNew: string;
  homeGroupRename: string;
  homeGroupDelete: string;
  homeGroupDeleteConfirm: string;
  homeGroupMoveToGroup: string;
  homeGroupNodeCount: string;
  homeGroupColor: string;
  homeGroupColorClear: string;
  homeGroupCollapse: string;
  homeGroupExpand: string;
  homeGroupDuplicate: string;
  homeGroupNewName: string;
  homeRecentActivity: string;
  homeFooterVersion: string;
  homeFooterGitHub: string;
  homeNoConnections: string;
  homeSearchHint: string;
  homeSearchConnections: string;
  homeSearchWeb: string;
  homeSearchTldr: string;
  homeSearching: string;
  homeSearchLoadMore: string;
  homeSearchPerPage: string;
  homeNoResults: string;
  editorLargeFileWarning: string;
  editorLargeFileTitle: string;
  editorUnsavedChanges: string;
  editorSaving: string;
  editorSaved: string;
  editorSaveFailed: string;
  editorDisconnected: string;
  editorReadOnly: string;
  editorLoading: string;
}

const translations: Record<Language, Translations> = {
  en: {
    appName: 'MeTerm',
    settings: 'Settings',
    settingsTabAppearance: 'Appearance',
    settingsTabTerminal: 'Terminal',
    settingsTabGeneral: 'General',
    theme: 'Terminal Theme',
    opacity: 'Background Opacity',
    enableVibrancy: 'Background Blur (Vibrancy)',
    fontSize: 'Font Size',
    fontFamily: 'Font',
    enableNerdFont: 'Nerd Font Icons',
    enableLigatures: 'Ligatures',
    enableBoldFont: 'Bold',
    encoding: 'Encoding',
    fileManagerFontSize: 'File Manager Font Size',
    previewRefreshRate: 'Preview Refresh Rate',
    newTerminal: 'New Terminal',
    noSessions: 'No terminal sessions',
    newSessionHint: 'Press ⌘T or click "New Terminal" to create one',
    connecting: 'Connecting',
    connected: 'Connected',
    reconnecting: 'Reconnecting',
    ended: 'Ended',
    sessionNotFound: 'Session not found',
    disconnected: 'Disconnected',
    reconnect: 'Reconnect',
    active: 'Active',
    language: 'Language',
    closeSession: 'Close Session',
    contextMenuNewTerminal: 'New Terminal',
    contextMenuHome: 'Home',
    contextMenuSettings: 'Settings',
    contextMenuCloseSession: 'Close Current Session',
    contextMenuCopy: 'Copy',
    contextMenuPaste: 'Paste',
    responseSession: 'Response Session',
    hideToTrayTipTitle: 'Hide to tray?',
    hideToTrayTipBody: 'Hide the window to system tray? Click the tray icon to reopen.',
    hideToTrayTipDontShow: "Don't show again",
    hideToTrayTipOk: 'Got it',
    hideToTrayTipHideNow: 'Hide now',
    hideToTrayTipCancel: 'Cancel',
    hideToTrayTipRemember: 'Remember this choice?',
    confirmQuitWithSessions: 'There are active sessions. Quit and close all sessions?',
    confirmCloseAllSessions: 'Close all sessions now?',
    confirmCloseWindowWithSessions: 'This window has active sessions. Close window and end all sessions?',
    confirmQuitAllWindows: 'Close all windows and sessions? This will quit the application.',
    confirmHideToTrayWithSessions: 'Active sessions detected. Hide window to tray?',
    aboutDialogTitle: 'About',
    aboutDialogBody: 'A lightweight multi-session terminal client.',
    shortcutsDialogTitle: 'Keyboard Shortcuts',
    shortcutsDialogBody: '',
    shortcutNewTerminal: 'New Terminal',
    shortcutCloseSession: 'Close Current Session',
    shortcutClearTerminal: 'Clear Terminal',
    shortcutClearInput: 'Clear Input Line',
    shortcutOpenSettings: 'Open Settings',
    shortcutSplitHorizontal: 'Split Horizontal',
    shortcutSplitVertical: 'Split Vertical',
    shortcutNavigatePanes: 'Navigate Between Panes',
    shortcutSwitchToTab: 'Switch to Tab 1–8 / Last',
    shortcutNextTab: 'Next Tab',
    shortcutPrevTab: 'Previous Tab',
    colorScheme: 'Appearance',
    colorSchemeAuto: 'Auto (System)',
    colorSchemeDark: 'Dark',
    colorSchemeDarker: 'Midnight',
    colorSchemeNavy: 'Deep Navy',
    colorSchemeLight: 'Light',
    rememberWindowSize: 'Remember Window Size',
    rememberDrawerLayout: 'Remember Drawer Layout',
    pipScale: 'PiP Window Scale',
    pipScaleByScreen: 'Scale relative to screen size',
    sessionsGallery: 'Sessions',
    sshConnect: 'SSH Connection',
    sshHost: 'Host',
    sshPort: 'Port',
    sshUsername: 'Username',
    sshAuthMethod: 'Auth Method',
    sshPassword: 'Password',
    sshPrivateKey: 'Private Key Path',
    sshConnectBtn: 'Connect',
    sshDisconnect: 'Disconnect',
    sshConnecting: 'Connecting...',
    sshConnected: 'Connected',
    sshFailed: 'Connection Failed',
    sshAuthPassword: 'Password',
    sshAuthKey: 'Public Key',
    sshSavedConnections: 'Saved Connections',
    sshNoSavedConnections: 'No saved connections',
    sshQuickConnect: 'Quick Connect',
    sshNewConnection: 'New Connection',
    sshDeleteConnection: 'Delete',
    sshConnectionName: 'Connection Name',
    sshSaveConnection: 'Save',
    sshTestConnection: 'Test',
    sshTestSuccess: 'Connection successful!',
    sshTestFailed: 'Connection failed',
    sshTesting: 'Testing...',
    sshConnectAndSave: 'Connect & Save',
    sshUnsavedConfirm: 'You have unsaved changes. Discard?',
    sshUnsavedDiscard: 'Discard',
    sshUnsavedCancel: 'Cancel',
    sshAuthFailedTitle: 'Authentication Failed',
    sshAuthFailedMsg: 'The saved password may have changed. Please enter the new password for {username}@{host}:',
    sshAuthFailedRetry: 'Reconnect',
    sshPasswordUpdated: 'Password updated and saved.',
    drawerTabFiles: 'Files',
    drawerTabProcesses: 'Processes',
    serverInfoHost: 'Host',
    serverInfoUser: 'User',
    serverInfoOS: 'OS',
    serverInfoKernel: 'Kernel',
    serverInfoUptime: 'Uptime',
    serverInfoCPU: 'CPU',
    serverInfoMemory: 'Memory',
    serverInfoDisk: 'Disk',
    serverInfoNetwork: 'Network',
    serverInfoLoading: 'Loading...',
    processColPID: 'PID',
    processColName: 'Name',
    processColUser: 'User',
    processColCPU: 'CPU%',
    processColMem: 'MEM%',
    processColTime: 'Time',
    backgroundImage: 'Background Image',
    backgroundImageOpacity: 'Image Opacity',
    backgroundImageSelect: 'Select Image',
    backgroundImageClear: 'Clear',
    homeNewLocalSession: 'New Local Session',
    homeNewSSHSession: 'New SSH Session',
    noShellsFound: 'No shells found',
    defaultShell: 'default',
    defaultShellSetting: 'Default Shell',
    contextMenuIntegration: 'Add "Open in MeTerm" to context menu',
    systemDefault: 'System Default',
    homeSavedConnections: 'Saved Connections',
    homeEditConnection: 'Edit',
    homeShowMore: 'Show More',
    homeShowLess: 'Show Less',
    homeRecentConnections: 'Recent',
    aiCapsule: 'AI Assistant',
    aiBarOpacity: 'AI Bar Opacity',
    aiSendCommand: 'Send Command',
    aiSendPrompt: 'Send Prompt',
    aiModelSelect: 'Model',
    aiPlaceholderInput: 'Type a command or prompt...',
    aiPlaceholderCmd: 'Command ',
    aiPlaceholderAgent: ' Agent chat ',
    aiCollapse: 'Collapse',
    aiExpand: 'Expand',
    aiHistory: 'History',
    aiHistoryEmpty: 'No command history',
    aiSearchHistory: 'Search command history...',
    aiSearchChatHistory: 'Search chat history...',
    aiSourceManual: 'Manual',
    aiTimeJustNow: 'just now',
    aiCopyCommand: 'Copy command',
    settingsTabAI: 'AI',
    aiProvider: 'Provider',
    aiPreset: 'Quick Select',
    aiApiKey: 'API Key',
    aiBaseUrl: 'API Base URL',
    aiModelName: 'Model',
    aiTemperature: 'Temperature',
    aiMaxTokens: 'Max Tokens',
    aiContextLines: 'Context Lines',
    aiAgentTrustLevel: 'Agent Trust Level',
    aiAgentTrustManual: 'Manual — confirm all actions',
    aiAgentTrustSemiAuto: 'Semi-Auto — confirm risky actions',
    aiAgentTrustFullAuto: 'Full-Auto — only confirm destructive',
    aiAgentMaxIterations: 'Max Agent Steps',
    aiAgentUnlimited: 'Unlimited',
    aiTestConnection: 'Test Connection',
    aiTestSuccess: 'Connection successful!',
    aiTestFailed: 'Connection failed',
    aiTesting: 'Testing...',
    aiNewChat: 'New Chat',
    aiClearChat: 'Clear Chat',
    aiRunCommand: 'Run',
    aiCopyCode: 'Copy',
    aiDangerConfirmTitle: 'Dangerous Command',
    aiDangerConfirmMsg: 'This command may cause irreversible changes. Are you sure you want to run it?',
    aiDangerConfirmRun: 'Run Anyway',
    aiDangerConfirmCancel: 'Cancel',
    aiNoConfig: 'AI not configured. Go to Settings > AI to set up.',
    aiStreamError: 'Request failed',
    aiRateLimitRetry: 'Rate limited, retrying',
    aiServerErrorRetry: 'Server error, retrying',
    aiContextCompressed: 'Context compressed to fit model limits',
    aiThinking: 'Thinking',
    aiWorking: 'Working',
    aiStopGenerating: 'Stop',
    aiCtxCopy: 'Copy',
    aiCtxCopyResult: 'Copy Result',
    aiCtxResend: 'Resend',
    aiCtxDelete: 'Delete',
    aiModelAuto: 'Auto',
    aiModelAutoDesc: 'Use default model for current provider',
    aiAddProvider: 'Add Provider',
    aiDeleteProvider: 'Delete',
    aiProviderProtocol: 'Protocol',
    aiFetchModels: 'Fetch Models',
    aiFetching: 'Fetching...',
    aiFetchSuccess: 'models loaded',
    aiFetchFailed: 'Fetch failed',
    aiNoModels: 'No models. Click "Fetch Models" to load.',
    aiModelsCount: 'models',
    aiSelectModels: 'Select Models',
    aiProviderLabel: 'Name',
    aiCustomProvider: 'Custom',
    aiSearxng: 'Web Search (SearXNG)',
    aiSearxngUrl: 'SearXNG URL',
    aiSearxngUrlPlaceholder: 'https://searx.example.org',
    aiSearxngUsername: 'Username (optional)',
    aiSearxngPassword: 'Password (optional)',
    aiSearxngEnable: 'Enable web search tool for AI agent',
    aiSearxngTest: 'Test',
    aiSearxngTestOk: 'SearXNG connected!',
    aiSearxngTestFail: 'SearXNG connection failed',
    tabMenuCloseTab: 'Close Tab',
    tabMenuCloseOthers: 'Close Other Tabs',
    tabMenuCloseLeft: 'Close Tabs to the Left',
    tabMenuCloseRight: 'Close Tabs to the Right',
    tabMenuCloseAll: 'Close All Tabs',
    tabMenuCopyTitle: 'Copy Tab Title',
    tabMenuCloneTab: 'Clone Tab',
    splitHorizontal: 'Split Horizontal',
    splitVertical: 'Split Vertical',
    closePane: 'Close Pane',
    pairingTitle: 'Mobile Pairing',
    pairingSubtitle: 'Scan QR code or copy pairing data in mobile app',
    pairingDeviceName: 'Device Name',
    pairingAddress: 'Address',
    pairingCopyData: 'Copy Pairing Data',
    pairingCopied: 'Copied!',
    pairingClose: 'Close',
    homeMobilePairing: 'Mobile Pairing',
    masterRequestTitle: 'Control Request',
    masterRequestMessage: 'A remote viewer wants to take control of the terminal.',
    masterRequestApprove: 'Approve',
    masterRequestDeny: 'Deny',
    reclaimControl: 'Reclaim Control',
    reclaimClickHint: 'Click to reclaim control',
    reclaimSpaceHint: '(Press Space to reclaim)',
    shareLink: 'Copy Share Link',
    shareLinkCopied: 'Link Copied!',
    settingsTabSharing: 'Sharing',
    sshExportConnections: 'Export Connections',
    sshImportConnections: 'Import Connections',
    sshExportSuccess: 'Connections exported successfully',
    sshImportSuccess: 'Connections imported successfully',
    sshImportFailed: 'Import failed',
    sshImportInvalidFormat: 'Invalid file format',
    sshImportCount: 'connections imported',
    sshExportCount: 'connections exported',
    sshNoConnectionsToExport: 'No connections to export',
    homeRemoteConnect: 'Remote Connect',
    remoteConnectTitle: 'Remote Connect',
    remoteConnectSubtitle: 'Connect to a running MeTerm server on the network',
    remoteTabUrl: 'URL',
    remoteTabJson: 'JSON',
    remoteTabScan: 'Scan',
    remoteUrlPlaceholder: '192.168.1.10:8080 or http://host:port/',
    remoteJsonPlaceholder: 'Paste pairing JSON data here...',
    remoteConnectBtn: 'Connect',
    remoteConnecting: 'Connecting...',
    remoteConnected: 'Connected',
    remoteFailed: 'Connection failed',
    remoteInvalidUrl: 'Invalid address or missing token',
    remoteInvalidJson: 'Invalid JSON format',
    remoteScanComingSoon: 'LAN scan coming soon',
    remoteSelectSession: 'Select a session to view',
    remoteNoSessions: 'No active sessions on this server',
    remoteViewerMode: 'Viewer',
    remoteTokenLabel: 'Token',
    remoteTokenPlaceholder: 'Authentication token',
    remoteSessionList: 'Remote Sessions',
    remoteSessionRefresh: 'Refresh',
    remoteSessionAutoRefresh: 'Auto Refresh',
    remoteSessionServer: 'Server',
    remoteSessionNoRemote: 'No remote connections',
    remoteSessionOpened: 'Opened',
    viewerRequestControl: 'Request Control',
    viewerRequesting: 'Requesting...',
    viewerRequestDenied: 'Request Denied',
    viewerObserving: 'Observing',
    remoteEditTitle: 'Edit Remote Connection',
    remoteSaveBtn: 'Save',
    remoteConnectionName: 'Connection Name',
    remoteHost: 'Host',
    remotePort: 'Port',
    remoteToken: 'Token',
    remoteSavedToHome: 'Saved to home page',
    remoteSaveConnection: 'Save Connection',
    remoteDeleteConnection: 'Delete',
    sshHostKeyUnknownTitle: 'Unknown Host Key',
    sshHostKeyUnknownMsg: 'The authenticity of host "{hostname}" cannot be established. Do you want to trust this host and continue connecting?',
    sshHostKeyType: 'Key Type',
    sshHostKeyFingerprint: 'Fingerprint',
    sshHostKeyTrust: 'Trust & Connect',
    sshHostKeyMismatchMsg: 'WARNING: Host key for {hostname} has CHANGED! This may indicate a man-in-the-middle attack. Key type: {keyType}, Fingerprint: {fingerprint}. Connection refused.',
    remotePairRequest: 'Request Pairing',
    remotePairing: 'Requesting pairing...',
    remotePairApproved: 'Pairing approved!',
    remotePairDenied: 'Pairing denied',
    remotePairTimeout: 'Pairing request timed out',
    remotePairCancel: 'Cancel',
    pairApprovalTitle: 'New Device Pairing',
    pairApprovalMessage: 'A new device wants to connect to your terminal.',
    pairApprovalDevice: 'Device',
    pairApprovalAddress: 'Address',
    pairApprovalApprove: 'Approve',
    pairApprovalDeny: 'Deny',
    remoteAddressLabel: 'Address',
    remoteScanBtn: 'Scan',
    remoteScanStop: 'Stop',
    remoteScanScanning: 'Scanning LAN...',
    remoteScanFound: 'Found {count} server(s)',
    remoteScanEmpty: 'No meterm servers found on LAN',
    remoteScanVerifying: 'Verifying...',
    remoteScanVerified: 'Verified',
    remoteScanUnreachable: 'Unreachable',
    remoteScanConnect: 'Connect',
    remoteScanNoLocalServer: 'Local server not running',
    remoteScanError: 'Scan failed',
    settingsDiscoverable: 'Allow LAN devices to discover this computer',
    connectedDevices: 'Connected Devices',
    kickClient: 'Kick',
    kickAndBan: 'Kick & Ban',
    ipBanList: 'IP Ban List',
    unbanIp: 'Unban',
    noConnectedDevices: 'No connected devices',
    noBannedIps: 'No banned IPs',
    tokenManagement: 'Token Management',
    currentToken: 'Current Token',
    refreshToken: 'Refresh Token',
    tokenRefreshed: 'Token refreshed',
    customToken: 'Custom Token',
    customTokenPlaceholder: 'Enter custom token (min 8 chars)',
    customTokenTooShort: 'Token must be at least 8 characters',
    setToken: 'Set',
    revokeAllClients: 'Disconnect All Clients',
    confirmRevokeAll: 'This will disconnect all remote clients and refresh the token. Existing paired devices will need to re-pair.',
    tokenSetSuccess: 'Token updated',
    revokeSuccess: 'Disconnected, token refreshed',
    kickSuccess: 'Kicked',
    deviceCardSessions: 'Sessions',
    devicePairedIdle: 'Paired (idle)',
    deviceCardKickDevice: 'Kick Device',
    kickDeviceConfirm: 'Kick all connections from this device?',
    kickDeviceSuccess: 'Device kicked',
    tabMenuLockSession: 'Lock (Private)',
    tabMenuUnlockSession: 'Unlock',
    lockSessionConfirm: 'Lock this session? Remote viewers will be disconnected.',
    sessionPrivate: 'Private',
    newPrivateTerminal: 'New Private Terminal',
    kickedByHost: 'Kicked',
    kickedOverlayMsg: 'You have been disconnected by the host.',
    closeTab: 'Close Tab',
    confirmBanIp: 'Also ban this device\'s IP address?',
    banIpYes: 'Ban IP',
    banIpSkip: 'Skip',
    confirmKickClient: 'Kick this client?',
    confirmLockAfterKick: 'Lock this session to prevent reconnection?',
    sessionPrivateCannotConnect: 'This session is private and cannot be connected.',
    remoteSessionClosed: 'The remote session has been closed by the host.',
    enableTerminalNotifications: 'Terminal Notifications',
    banDevice: 'Ban Device',
    banDeviceConfirm: 'Ban this device and disconnect all its connections?',
    remoteTypeBadge: 'Remote',
    remoteScanLan: 'Scan LAN',
    remoteRescan: 'Rescan',
    aiChatHistory: 'Chat History',
    aiChatHistoryEmpty: 'No chat history',
    aiChatHistoryTitle: 'Chat History',
    aiChatDeleteConfirmTitle: 'Delete Conversation',
    aiChatDeleteConfirmMsg: 'Are you sure you want to delete this conversation?',
    aiChatDeleteConfirmOk: 'Delete',
    aiChatDeleteConfirmCancel: 'Cancel',
    aiChatDeleteNoAskMinutes: "Don't ask again for 5 minutes",
    aiChatHistoryBack: 'Back',
    updateAvailable: 'New version {version} is available',
    updateNow: 'Update Now',
    updateLater: 'Later',
    updateDownloading: 'Downloading {pct}%',
    updateFinishing: 'Installing...',
    updateRestarting: 'Restarting...',
    updateHint: 'The app will restart automatically after installation.',
    updateFailed: 'Update Failed',
    updateFailedHint: 'Please try again later or download the latest version manually.',
    updateModalTitle: 'Update to {version}',
    updateReleaseNotes: 'Release Notes',
    checkUpdates: 'Check for Updates',
    checkUpdatesUpToDate: "You're up to date",
    checkUpdatesChecking: 'Checking for updates…',
    updateModalClose: 'Close',
    hideUpdateIcon: 'Hide title bar update icon',
    openFileManager: 'Open File Manager',
    navigateConfirmMsg: 'Open file manager and navigate to {path}?',
    navigateCancel: 'Cancel',
    navigateConfirm: 'Open',
    fileLinkHint: '{mod}+Click to open {name}',
    fileLinkOpenLocal: 'Open with Default App',
    fileLinkOpenInDrawer: 'Open in File Manager',
    fileLinkDontAskAgain: "Don't ask again",
    fileLinkLocalConfirmMsg: 'Open <code>{path}</code> with system default application?',
    fileLinkConfirmOpen: 'Open',
    fileLinkSkipConfirmSetting: 'Show file link open confirmation',
    autoNewSession: 'Auto-create local session on startup',
    // JumpServer
    jsEditServer: 'Edit JumpServer',
    jsAddServer: 'Add JumpServer',
    jsName: 'Name',
    jsBaseUrl: 'Server URL',
    jsSshHost: 'SSH Host',
    jsSshHostPlaceholder: 'Koko SSH host (default: same as server)',
    jsAuthMethod: 'Auth Method',
    jsAuthPassword: 'Password',
    jsAuthToken: 'API Token',
    jsApiToken: 'API Token',
    jsOrgId: 'Organization ID',
    jsOrgIdPlaceholder: 'Optional, leave empty for default',
    jsTestConnection: 'Test',
    jsTesting: 'Testing…',
    jsTestSuccess: 'Connection successful',
    jsTestFailed: 'Connection failed',
    jsSave: 'Save',
    jsFieldsRequired: 'Name and Server URL are required',
    jsInvalidUrl: 'Invalid URL format',
    jsMfaTitle: 'Multi-Factor Authentication',
    jsMfaDesc: 'Enter the verification code',
    jsMfaCodePlaceholder: 'Verification code',
    jsMfaVerify: 'Verify',
    jsAssetBrowser: 'Asset Browser',
    jsSearchAssets: 'Search assets…',
    jsLoading: 'Loading…',
    jsAllAssets: 'All Assets',
    jsAssetsTotal: 'assets',
    jsNoAssets: 'No assets found',
    jsAssetName: 'Name',
    jsAssetAddress: 'Address',
    jsAssetPlatform: 'Platform',
    jsAssetComment: 'Comment',
    jsAssetProtocols: 'Protocols',
    jsAssetActions: 'Actions',
    jsConnect: 'Connect',
    jsLoadingAccounts: 'Loading accounts…',
    jsNoAccounts: 'No accounts available',
    jsSelectAccount: 'Select Account',
    homeNewJumpServer: 'JumpServer',
    jsSaveAndConnect: 'Save & Connect',
    homeSearchPlaceholder: 'Search connections, commands or docs',
    homeGroupDefault: 'Default',
    homeGroupUngrouped: 'Ungrouped',
    homeGroupManage: 'Manage Groups',
    homeGroupNew: 'New Group',
    homeGroupRename: 'Rename',
    homeGroupDelete: 'Delete Group',
    homeGroupDeleteConfirm: 'Delete this group? Connections will be moved to Ungrouped.',
    homeGroupMoveToGroup: 'Move to Group',
    homeGroupNodeCount: '{count} Nodes',
    homeGroupColor: 'Color',
    homeGroupColorClear: 'Clear Color',
    homeGroupCollapse: 'Collapse',
    homeGroupExpand: 'Expand',
    homeGroupDuplicate: 'Duplicate Group',
    homeGroupNewName: 'Group Name',
    homeRecentActivity: 'Recent Activity',
    homeFooterVersion: 'MeTerm v{version}',
    homeFooterGitHub: 'GitHub',
    homeNoConnections: 'No connections yet',
    homeSearchHint: 'Type to search connections, web, and command docs',
    homeSearchConnections: 'Connections',
    homeSearchWeb: 'Web Search',
    homeSearchTldr: 'Command Docs',
    homeSearching: 'Searching...',
    homeSearchLoadMore: 'Load more',
    homeSearchPerPage: '/page',
    homeNoResults: 'No results',
    settingsTabAbout: 'About',
    aboutVersion: 'Version',
    aboutDescription: 'A lightweight multi-session terminal client.',
    aboutGitHub: 'GitHub',
    aboutGitee: 'Gitee',
    aboutLicense: 'License',
    aboutCopyright: 'Copyright',
    aboutCheckUpdate: 'Check for Updates',
    aboutOpenSource: 'Open Source (in no particular order)',
    aboutLicenses: 'Licenses',
    aboutAckXterm: 'Terminal emulator',
    aboutAckTauri: 'Desktop framework',
    aboutAckConpty: 'Windows ConPTY',
    aboutAckJumpserver: 'Bastion host API',
    aboutAckTldr: 'Command documentation',
    aboutAckSearxng: 'Web search API',
    aboutAckCodemirror: 'Code editor',
    // tldr & command completion
    tldrHelp: 'Command Help',
    tldrEnable: 'Enable tldr command help',
    tldrNoData: 'No help data available. Click "Update Now" to download.',
    tldrUpdating: 'Updating help data…',
    tldrLastUpdated: 'Last updated: {date}',
    tldrUpdateNow: 'Update Now',
    tldrPageCount: '{count} commands indexed',
    tldrExamples: 'Examples',
    cmdCompletionEnable: 'Enable command completion (inline ghost text)',
    cmdCompletionHint: 'Shows gray suggestion text in terminal, press → to accept',
    cmdCompletionHistoryHint: 'Based on command history (priority) and tldr command index',
    shellHookInjection: 'Shell Hook Injection',
    shellHookEnable: 'Auto-inject shell hook on SSH/remote sessions',
    shellHookHint: 'Injects a shell hook via PTY command on SSH sessions for full command history (including Tab completions). Without this, history is recorded from keyboard input only.\n\u26A0\uFE0F Windows: NOT recommended — may cause window freeze or console flash due to ConPTY/WebView2 limitations.\n\u2705 macOS/Linux: Safe to enable.',
    editorLargeFileWarning: 'This file is {size} MB. Opening large files may cause lag or crashes. Continue?',
    editorLargeFileTitle: 'Large File Warning',
    editorUnsavedChanges: 'You have unsaved changes. Discard and close?',
    editorSaving: 'Saving...',
    editorSaved: 'Saved',
    editorSaveFailed: 'Save failed',
    editorDisconnected: 'Session disconnected',
    editorReadOnly: 'Read-only',
    editorLoading: 'Loading...',
  },
  zh: {
    appName: 'MeTerm',
    settings: '设置',
    settingsTabAppearance: '外观',
    settingsTabTerminal: '终端',
    settingsTabGeneral: '通用',
    theme: '终端主题',
    opacity: '背景透明度',
    enableVibrancy: '背景模糊（毛玻璃）',
    fontSize: '字体大小',
    fontFamily: '字体',
    enableNerdFont: 'Nerd Font 图标',
    enableLigatures: '编程连字',
    enableBoldFont: '加粗',
    encoding: '字符编码',
    fileManagerFontSize: '文件管理器字体大小',
    previewRefreshRate: '预览刷新频率',
    newTerminal: '新建终端',
    noSessions: '没有终端会话',
    newSessionHint: '按 ⌘T 或点击 "新建终端" 创建一个',
    connecting: '连接中',
    connected: '已连接',
    reconnecting: '重连中',
    ended: '已结束',
    sessionNotFound: '会话未找到',
    disconnected: '已断开',
    reconnect: '重新连接',
    active: '当前',
    language: '语言',
    closeSession: '关闭会话',
    contextMenuNewTerminal: '新建终端',
    contextMenuHome: '主页',
    contextMenuSettings: '设置',
    contextMenuCloseSession: '关闭当前会话',
    contextMenuCopy: '复制',
    contextMenuPaste: '粘贴',
    responseSession: '响应会话',
    hideToTrayTipTitle: '隐藏到系统托盘？',
    hideToTrayTipBody: '将窗口隐藏到系统托盘？点击托盘图标可重新打开。',
    hideToTrayTipDontShow: '不再提示',
    hideToTrayTipOk: '知道了',
    hideToTrayTipHideNow: '隐藏到状态栏',
    hideToTrayTipCancel: '取消',
    hideToTrayTipRemember: '记住选项？',
    confirmQuitWithSessions: '当前有未关闭会话，确认退出并关闭全部会话吗？',
    confirmCloseAllSessions: '确认关闭所有会话吗？',
    confirmCloseWindowWithSessions: '此窗口有活跃的会话。关闭窗口将结束所有会话，是否继续？',
    confirmQuitAllWindows: '关闭所有窗口及会话？这将退出应用程序。',
    confirmHideToTrayWithSessions: '检测到有活跃会话，是否将窗口隐藏到状态栏？',
    aboutDialogTitle: '关于',
    aboutDialogBody: '轻量的多会话终端客户端。',
    shortcutsDialogTitle: '快捷键',
    shortcutsDialogBody: '',
    shortcutNewTerminal: '新建终端',
    shortcutCloseSession: '关闭当前会话',
    shortcutClearTerminal: '清屏',
    shortcutClearInput: '清空当前输入',
    shortcutOpenSettings: '打开设置',
    shortcutSplitHorizontal: '水平分屏',
    shortcutSplitVertical: '垂直分屏',
    shortcutNavigatePanes: '在面板间导航',
    shortcutSwitchToTab: '切换到第 1–8 / 最后一个标签',
    shortcutNextTab: '下一个标签',
    shortcutPrevTab: '上一个标签',
    colorScheme: '外观模式',
    colorSchemeAuto: '自动（跟随系统）',
    colorSchemeDark: '深色',
    colorSchemeDarker: '纯黑',
    colorSchemeNavy: '深海蓝',
    colorSchemeLight: '浅色',
    rememberWindowSize: '记住窗口大小',
    rememberDrawerLayout: '记住抽屉布局',
    pipScale: '画中画窗口缩放比例',
    pipScaleByScreen: '根据屏幕大小比例进行缩放',
    sessionsGallery: '会话总览',
    sshConnect: 'SSH 连接',
    sshHost: '主机地址',
    sshPort: '端口',
    sshUsername: '用户名',
    sshAuthMethod: '认证方式',
    sshPassword: '密码',
    sshPrivateKey: '私钥路径',
    sshConnectBtn: '连接',
    sshDisconnect: '断开连接',
    sshConnecting: '连接中...',
    sshConnected: '已连接',
    sshFailed: '连接失败',
    sshAuthPassword: '密码认证',
    sshAuthKey: '公钥认证',
    sshSavedConnections: '已保存的连接',
    sshNoSavedConnections: '暂无保存的连接',
    sshQuickConnect: '快速连接',
    sshNewConnection: '新建连接',
    sshDeleteConnection: '删除',
    sshConnectionName: '连接名称',
    sshSaveConnection: '保存',
    sshTestConnection: '测试连接',
    sshTestSuccess: '连接成功！',
    sshTestFailed: '连接失败',
    sshTesting: '测试中...',
    sshConnectAndSave: '连接并保存',
    sshUnsavedConfirm: '有未保存的更改，确定关闭？',
    sshUnsavedDiscard: '放弃',
    sshUnsavedCancel: '取消',
    sshAuthFailedTitle: '认证失败',
    sshAuthFailedMsg: '保存的密码可能已变更，请输入 {username}@{host} 的新密码：',
    sshAuthFailedRetry: '重新连接',
    sshPasswordUpdated: '密码已更新并保存。',
    drawerTabFiles: '文件',
    drawerTabProcesses: '进程',
    serverInfoHost: '主机',
    serverInfoUser: '用户',
    serverInfoOS: '系统',
    serverInfoKernel: '内核',
    serverInfoUptime: '运行',
    serverInfoCPU: 'CPU',
    serverInfoMemory: '内存',
    serverInfoDisk: '磁盘',
    serverInfoNetwork: '网络',
    serverInfoLoading: '加载中...',
    processColPID: 'PID',
    processColName: '进程名',
    processColUser: '用户',
    processColCPU: 'CPU%',
    processColMem: '内存%',
    processColTime: '运行时间',
    backgroundImage: '背景图片',
    backgroundImageOpacity: '图片透明度',
    backgroundImageSelect: '选择图片',
    backgroundImageClear: '清除',
    homeNewLocalSession: '新建本地会话',
    homeNewSSHSession: '新建 SSH 会话',
    noShellsFound: '未找到可用的 Shell',
    defaultShell: '默认',
    defaultShellSetting: '默认 Shell',
    contextMenuIntegration: '添加"在 MeTerm 中打开"到右键菜单',
    systemDefault: '跟随系统',
    homeSavedConnections: '已保存的连接',
    homeEditConnection: '编辑',
    homeShowMore: '展开更多',
    homeShowLess: '收起',
    homeRecentConnections: '最近连接',
    aiCapsule: 'AI 助手',
    aiBarOpacity: 'AI 栏透明度',
    aiSendCommand: '发送命令',
    aiSendPrompt: '发送提示词',
    aiModelSelect: '模型',
    aiPlaceholderInput: '输入命令或提示词...',
    aiPlaceholderCmd: '命令 ',
    aiPlaceholderAgent: ' Agent 对话 ',
    aiCollapse: '收起',
    aiExpand: '展开',
    aiHistory: '历史',
    aiHistoryEmpty: '暂无命令历史',
    aiSearchHistory: '搜索命令历史...',
    aiSearchChatHistory: '搜索对话历史...',
    aiSourceManual: '手动',
    aiTimeJustNow: '刚刚',
    aiCopyCommand: '复制命令',
    settingsTabAI: 'AI',
    aiProvider: '服务商',
    aiPreset: '快速选择',
    aiApiKey: 'API 密钥',
    aiBaseUrl: 'API 地址',
    aiModelName: '模型',
    aiTemperature: '温度',
    aiMaxTokens: '最大 Token',
    aiContextLines: '上下文行数',
    aiAgentTrustLevel: 'Agent 信任级别',
    aiAgentTrustManual: '手动 — 所有操作均需确认',
    aiAgentTrustSemiAuto: '半自动 — 仅危险操作需确认',
    aiAgentTrustFullAuto: '全自动 — 仅极端危险操作需确认',
    aiAgentMaxIterations: '最大执行步数',
    aiAgentUnlimited: '无限制',
    aiTestConnection: '测试连接',
    aiTestSuccess: '连接成功！',
    aiTestFailed: '连接失败',
    aiTesting: '测试中...',
    aiNewChat: '新对话',
    aiClearChat: '清空对话',
    aiRunCommand: '执行',
    aiCopyCode: '复制',
    aiDangerConfirmTitle: '危险命令',
    aiDangerConfirmMsg: '该命令可能造成不可逆的更改，确定要执行吗？',
    aiDangerConfirmRun: '仍然执行',
    aiDangerConfirmCancel: '取消',
    aiNoConfig: 'AI 未配置，请前往 设置 > AI 进行配置。',
    aiStreamError: '请求失败',
    aiRateLimitRetry: '请求频率受限，正在重试',
    aiServerErrorRetry: '服务暂时不可用，正在重试',
    aiContextCompressed: '上下文已压缩以适应模型限制',
    aiThinking: '思考中',
    aiWorking: '工作中',
    aiStopGenerating: '停止',
    aiCtxCopy: '复制',
    aiCtxCopyResult: '复制结果',
    aiCtxResend: '重新发送',
    aiCtxDelete: '删除',
    aiModelAuto: '自动',
    aiModelAutoDesc: '使用当前服务商的默认模型',
    aiAddProvider: '添加供应商',
    aiDeleteProvider: '删除',
    aiProviderProtocol: '协议',
    aiFetchModels: '拉取模型',
    aiFetching: '拉取中...',
    aiFetchSuccess: '个模型已加载',
    aiFetchFailed: '拉取失败',
    aiNoModels: '暂无模型，点击"拉取模型"加载。',
    aiModelsCount: '个模型',
    aiSelectModels: '选择模型',
    aiProviderLabel: '名称',
    aiCustomProvider: '自定义',
    aiSearxng: '网络搜索 (SearXNG)',
    aiSearxngUrl: 'SearXNG 地址',
    aiSearxngUrlPlaceholder: 'https://searx.example.org',
    aiSearxngUsername: '用户名（可选）',
    aiSearxngPassword: '密码（可选）',
    aiSearxngEnable: '为 AI 助手启用网络搜索工具',
    aiSearxngTest: '测试',
    aiSearxngTestOk: 'SearXNG 连接成功！',
    aiSearxngTestFail: 'SearXNG 连接失败',
    tabMenuCloseTab: '关闭此标签',
    tabMenuCloseOthers: '关闭其他标签',
    tabMenuCloseLeft: '关闭左侧标签',
    tabMenuCloseRight: '关闭右侧标签',
    tabMenuCloseAll: '关闭所有标签',
    tabMenuCopyTitle: '复制标签标题',
    tabMenuCloneTab: '克隆标签',
    splitHorizontal: '水平分屏',
    splitVertical: '垂直分屏',
    closePane: '关闭面板',
    pairingTitle: '手机配对',
    pairingSubtitle: '在手机端 App 中扫描此 QR 码或复制配对数据',
    pairingDeviceName: '设备名称',
    pairingAddress: '地址',
    pairingCopyData: '复制配对数据',
    pairingCopied: '已复制!',
    pairingClose: '关闭',
    homeMobilePairing: '手机配对',
    masterRequestTitle: '控制权申请',
    masterRequestMessage: '一个远程观察者请求控制终端。',
    masterRequestApprove: '同意',
    masterRequestDeny: '拒绝',
    reclaimControl: '夺回控制权',
    reclaimClickHint: '点击取消远控',
    reclaimSpaceHint: '(空格取消远控)',
    shareLink: '复制分享链接',
    shareLinkCopied: '链接已复制!',
    settingsTabSharing: '分享',
    sshExportConnections: '导出连接',
    sshImportConnections: '导入连接',
    sshExportSuccess: '连接导出成功',
    sshImportSuccess: '连接导入成功',
    sshImportFailed: '导入失败',
    sshImportInvalidFormat: '文件格式无效',
    sshImportCount: '个连接已导入',
    sshExportCount: '个连接已导出',
    sshNoConnectionsToExport: '没有可导出的连接',
    homeRemoteConnect: '远程连接',
    remoteConnectTitle: '远程连接',
    remoteConnectSubtitle: '连接到网络中运行的 MeTerm 服务端',
    remoteTabUrl: 'URL',
    remoteTabJson: 'JSON',
    remoteTabScan: '扫描',
    remoteUrlPlaceholder: '192.168.1.10:8080 或 http://host:port/',
    remoteJsonPlaceholder: '在此粘贴配对 JSON 数据...',
    remoteConnectBtn: '连接',
    remoteConnecting: '连接中...',
    remoteConnected: '已连接',
    remoteFailed: '连接失败',
    remoteInvalidUrl: '地址无效或缺少令牌',
    remoteInvalidJson: 'JSON 格式无效',
    remoteScanComingSoon: '局域网扫描即将推出',
    remoteSelectSession: '选择要查看的会话',
    remoteNoSessions: '此服务器上没有活跃会话',
    remoteViewerMode: '观察者',
    remoteTokenLabel: '令牌',
    remoteTokenPlaceholder: '认证令牌',
    remoteSessionList: '远程会话',
    remoteSessionRefresh: '刷新',
    remoteSessionAutoRefresh: '自动刷新',
    remoteSessionServer: '服务器',
    remoteSessionNoRemote: '无远程连接',
    remoteSessionOpened: '已打开',
    viewerRequestControl: '申请控制',
    viewerRequesting: '申请中...',
    viewerRequestDenied: '申请被拒绝',
    viewerObserving: '观察中',
    remoteEditTitle: '编辑远程连接',
    remoteSaveBtn: '保存',
    remoteConnectionName: '连接名称',
    remoteHost: '主机',
    remotePort: '端口',
    remoteToken: '令牌',
    remoteSavedToHome: '已保存到主页',
    remoteSaveConnection: '保存连接',
    remoteDeleteConnection: '删除',
    sshHostKeyUnknownTitle: '未知主机密钥',
    sshHostKeyUnknownMsg: '无法验证主机 "{hostname}" 的真实性。是否信任此主机并继续连接？',
    sshHostKeyType: '密钥类型',
    sshHostKeyFingerprint: '指纹',
    sshHostKeyTrust: '信任并连接',
    sshHostKeyMismatchMsg: '警告：主机 {hostname} 的密钥已变更！这可能表示中间人攻击。密钥类型：{keyType}，指纹：{fingerprint}。连接已拒绝。',
    remotePairRequest: '请求配对',
    remotePairing: '正在请求配对...',
    remotePairApproved: '配对已通过!',
    remotePairDenied: '配对被拒绝',
    remotePairTimeout: '配对请求超时',
    remotePairCancel: '取消',
    pairApprovalTitle: '新设备配对请求',
    pairApprovalMessage: '一个新设备请求连接到您的终端。',
    pairApprovalDevice: '设备',
    pairApprovalAddress: '地址',
    pairApprovalApprove: '批准',
    pairApprovalDeny: '拒绝',
    remoteAddressLabel: '地址',
    remoteScanBtn: '扫描',
    remoteScanStop: '停止',
    remoteScanScanning: '正在扫描局域网...',
    remoteScanFound: '发现 {count} 个服务',
    remoteScanEmpty: '未在局域网中发现 meterm 服务',
    remoteScanVerifying: '验证中...',
    remoteScanVerified: '已验证',
    remoteScanUnreachable: '不可达',
    remoteScanConnect: '连接',
    remoteScanNoLocalServer: '本地服务未启动',
    remoteScanError: '扫描失败',
    settingsDiscoverable: '允许局域网设备发现此电脑',
    connectedDevices: '已连接设备',
    kickClient: '踢出',
    kickAndBan: '踢出并封禁',
    ipBanList: 'IP 封禁列表',
    unbanIp: '解封',
    noConnectedDevices: '暂无连接设备',
    noBannedIps: '暂无封禁 IP',
    tokenManagement: 'Token 管理',
    currentToken: '当前 Token',
    refreshToken: '刷新 Token',
    tokenRefreshed: 'Token 已刷新',
    customToken: '自定义 Token',
    customTokenPlaceholder: '输入自定义 Token（至少 8 位）',
    customTokenTooShort: 'Token 至少需要 8 个字符',
    setToken: '设置',
    revokeAllClients: '断开所有客户端',
    confirmRevokeAll: '这将断开所有远程客户端并刷新 Token。已配对设备需要重新配对。',
    tokenSetSuccess: 'Token 已更新',
    revokeSuccess: '已断开，Token 已刷新',
    kickSuccess: '已踢出',
    deviceCardSessions: '连接会话',
    devicePairedIdle: '已配对（空闲）',
    deviceCardKickDevice: '踢出设备',
    kickDeviceConfirm: '确定踢出该设备的所有连接？',
    kickDeviceSuccess: '设备已踢出',
    tabMenuLockSession: '锁定（私有）',
    tabMenuUnlockSession: '解锁',
    lockSessionConfirm: '锁定此会话？远程观察者将被断开。',
    sessionPrivate: '私有',
    newPrivateTerminal: '新建私有终端',
    kickedByHost: '已被踢出',
    kickedOverlayMsg: '你已被主机断开连接。',
    closeTab: '关闭标签',
    confirmBanIp: '是否同时封禁该设备的 IP 地址？',
    banIpYes: '封禁 IP',
    banIpSkip: '跳过',
    confirmKickClient: '确定踢出此客户端？',
    confirmLockAfterKick: '是否锁定此会话以阻止重新连接？',
    sessionPrivateCannotConnect: '该会话为私有模式，无法连接。',
    remoteSessionClosed: '远程会话已被主机关闭。',
    enableTerminalNotifications: '终端通知',
    banDevice: '封禁设备',
    banDeviceConfirm: '封禁该设备并断开所有连接？',
    remoteTypeBadge: '远程',
    remoteScanLan: '扫描局域网',
    remoteRescan: '重新扫描',
    aiChatHistory: '对话历史',
    aiChatHistoryEmpty: '暂无对话历史',
    aiChatHistoryTitle: '对话历史',
    aiChatDeleteConfirmTitle: '删除对话',
    aiChatDeleteConfirmMsg: '确定要删除这条对话记录吗？',
    aiChatDeleteConfirmOk: '删除',
    aiChatDeleteConfirmCancel: '取消',
    aiChatDeleteNoAskMinutes: '5 分钟内不再提示',
    aiChatHistoryBack: '返回',
    updateAvailable: '新版本 {version} 已发布',
    updateNow: '立即更新',
    updateLater: '稍后',
    updateDownloading: '下载中 {pct}%',
    updateFinishing: '安装中...',
    updateRestarting: '重启中...',
    updateHint: '安装完成后应用将自动重启。',
    updateFailed: '更新失败',
    updateFailedHint: '请稍后重试，或手动下载最新版本。',
    updateModalTitle: '更新至 {version}',
    updateReleaseNotes: '更新说明',
    checkUpdates: '检查更新',
    checkUpdatesUpToDate: '当前已是最新版本',
    checkUpdatesChecking: '正在检查更新…',
    updateModalClose: '关闭',
    hideUpdateIcon: '关闭标题栏更新按钮',
    openFileManager: '打开文件管理器',
    navigateConfirmMsg: '是否打开文件管理器并跳转到 {path}？',
    navigateCancel: '取消',
    navigateConfirm: '打开',
    fileLinkHint: '{mod}+点击打开 {name}',
    fileLinkOpenLocal: '用本机关联程序打开',
    fileLinkOpenInDrawer: '在文件管理器中打开',
    fileLinkDontAskAgain: '不再提示',
    fileLinkLocalConfirmMsg: '是否使用系统默认程序打开 <code>{path}</code>？',
    fileLinkConfirmOpen: '打开',
    fileLinkSkipConfirmSetting: '显示文件链接打开确认弹窗',
    autoNewSession: '启动时自动创建本地会话',
    // JumpServer
    jsEditServer: '编辑 JumpServer',
    jsAddServer: '添加 JumpServer',
    jsName: '名称',
    jsBaseUrl: '服务器地址',
    jsSshHost: 'SSH 主机',
    jsSshHostPlaceholder: 'Koko SSH 主机（默认与服务器相同）',
    jsAuthMethod: '认证方式',
    jsAuthPassword: '密码',
    jsAuthToken: 'API 令牌',
    jsApiToken: 'API 令牌',
    jsOrgId: '组织 ID',
    jsOrgIdPlaceholder: '可选，留空使用默认组织',
    jsTestConnection: '测试',
    jsTesting: '测试中…',
    jsTestSuccess: '连接成功',
    jsTestFailed: '连接失败',
    jsSave: '保存',
    jsFieldsRequired: '名称和服务器地址为必填项',
    jsInvalidUrl: 'URL 格式无效',
    jsMfaTitle: '多因素认证',
    jsMfaDesc: '请输入验证码',
    jsMfaCodePlaceholder: '验证码',
    jsMfaVerify: '验证',
    jsAssetBrowser: '资产浏览器',
    jsSearchAssets: '搜索资产…',
    jsLoading: '加载中…',
    jsAllAssets: '全部资产',
    jsAssetsTotal: '个资产',
    jsNoAssets: '未找到资产',
    jsAssetName: '名称',
    jsAssetAddress: '地址',
    jsAssetPlatform: '平台',
    jsAssetComment: '备注',
    jsAssetProtocols: '协议',
    jsAssetActions: '操作',
    jsConnect: '连接',
    jsLoadingAccounts: '加载账户中…',
    jsNoAccounts: '没有可用账户',
    jsSelectAccount: '选择账户',
    homeNewJumpServer: 'JumpServer',
    jsSaveAndConnect: '保存并连接',
    homeSearchPlaceholder: '搜索连接、指令或文档',
    homeGroupDefault: '默认',
    homeGroupUngrouped: '未分组',
    homeGroupManage: '管理分组',
    homeGroupNew: '新建分组',
    homeGroupRename: '重命名',
    homeGroupDelete: '删除分组',
    homeGroupDeleteConfirm: '删除该分组？连接将移至未分组。',
    homeGroupMoveToGroup: '移动到分组',
    homeGroupNodeCount: '{count} 个节点',
    homeGroupColor: '颜色',
    homeGroupColorClear: '清除颜色',
    homeGroupCollapse: '折叠',
    homeGroupExpand: '展开',
    homeGroupDuplicate: '复制分组',
    homeGroupNewName: '分组名称',
    homeRecentActivity: '最近活跃',
    homeFooterVersion: 'MeTerm v{version}',
    homeFooterGitHub: 'GitHub',
    homeNoConnections: '暂无连接',
    homeSearchHint: '输入关键词搜索连接、网页和命令文档',
    homeSearchConnections: '连接',
    homeSearchWeb: '网络搜索',
    homeSearchTldr: '命令文档',
    homeSearching: '搜索中...',
    homeSearchLoadMore: '加载更多',
    homeSearchPerPage: '/页',
    homeNoResults: '无结果',
    settingsTabAbout: '关于',
    aboutVersion: '版本',
    aboutDescription: '轻量的多会话终端客户端。',
    aboutGitHub: 'GitHub',
    aboutGitee: 'Gitee',
    aboutLicense: '许可协议',
    aboutCopyright: '版权',
    aboutCheckUpdate: '检查更新',
    aboutOpenSource: '开源致谢（排名不分先后）',
    aboutLicenses: '开源致谢',
    aboutAckXterm: '终端模拟器',
    aboutAckTauri: '桌面应用框架',
    aboutAckConpty: 'Windows 伪控制台',
    aboutAckJumpserver: '堡垒机 API',
    aboutAckTldr: '命令文档',
    aboutAckSearxng: '网络搜索 API',
    aboutAckCodemirror: '代码编辑器',
    // tldr & 命令补全
    tldrHelp: '命令帮助',
    tldrEnable: '启用 tldr 命令帮助',
    tldrNoData: '暂无帮助数据，请点击"立即更新"下载。',
    tldrUpdating: '正在更新帮助数据…',
    tldrLastUpdated: '上次更新：{date}',
    tldrUpdateNow: '立即更新',
    tldrPageCount: '已索引 {count} 个命令',
    tldrExamples: '示例',
    cmdCompletionEnable: '启用命令补全（行内提示文字）',
    cmdCompletionHint: '在终端中自动显示灰色建议文字，按 → 接受',
    cmdCompletionHistoryHint: '基于历史命令（优先）和 tldr 命令索引',
    shellHookInjection: 'Shell Hook 注入',
    shellHookEnable: 'SSH/远程会话自动注入 Shell Hook',
    shellHookHint: '通过 PTY 命令在 SSH 会话中注入 Shell Hook，实现完整命令历史记录（含 Tab 补全）。关闭时仅通过键盘输入记录历史。\n⚠️ Windows：不建议开启 — ConPTY/WebView2 限制可能导致窗口冻结或控制台窗口闪现。\n✅ macOS/Linux：可以安全开启。',
    editorLargeFileWarning: '该文件大小为 {size} MB，打开大文件可能导致卡顿或崩溃。是否继续？',
    editorLargeFileTitle: '大文件警告',
    editorUnsavedChanges: '有未保存的更改，是否丢弃并关闭？',
    editorSaving: '保存中...',
    editorSaved: '已保存',
    editorSaveFailed: '保存失败',
    editorDisconnected: '会话已断开',
    editorReadOnly: '只读',
    editorLoading: '加载中...',
  },
};

const LANGUAGE_KEY = 'meterm-language';

let currentLanguage: Language = 'en';

export function initLanguage(): void {
  const stored = localStorage.getItem(LANGUAGE_KEY) as Language;
  if (stored && translations[stored]) {
    currentLanguage = stored;
  } else {
    const browserLang = navigator.language.slice(0, 2) as Language;
    if (translations[browserLang]) {
      currentLanguage = browserLang;
    }
  }
}

export function setLanguage(lang: Language): void {
  if (translations[lang]) {
    currentLanguage = lang;
    localStorage.setItem(LANGUAGE_KEY, lang);
  }
}

export function getLanguage(): Language {
  return currentLanguage;
}

export function t(key: keyof Translations): string {
  return translations[currentLanguage][key];
}

export function getAvailableLanguages(): { value: Language; label: string }[] {
  return [
    { value: 'en', label: 'English' },
    { value: 'zh', label: '中文' },
  ];
}

export function getCurrentTranslations(): Translations {
  return translations[currentLanguage];
}
