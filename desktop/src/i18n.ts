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
  uiFontFamily: string;
  cjkFontFamily: string;
  cjkFontAuto: string;
  enableNerdFont: string;
  enableLigatures: string;
  fontWeight: string;
  fontSharpness: string;
  encoding: string;
  fileManagerFontSize: string;
  enableThumbnail: string;
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
  colorSchemeNeoBrutalism: string;
  colorSchemeNeoBrutalismRounded: string;
  nbPaletteTitle: string;
  nbBg: string;
  nbText: string;
  nbBorder: string;
  nbShadow: string;
  nbAccent: string;
  nbHighlight: string;
  nbSuccess: string;
  nbInfo: string;
  nbDanger: string;
  nbSurfaceAlt: string;
  nbReset: string;
  nbPresetSunset: string;
  nbPresetOcean: string;
  nbPresetSakura: string;
  nbPresetForest: string;
  nbPresetLavender: string;
  nbPresetMidnight: string;
  nbPresetCyber: string;
  nbPresetAbyss: string;
  nbPresetCandy: string;
  nbPresetRetro: string;
  nbPresetNord: string;
  nbPresetDracula: string;
  nbPresetSolarized: string;
  nbPresetOnyx: string;
  nbPresetEmber: string;
  nbPresetMatrix: string;
  nbPresetStealth: string;
  nbPresetMocha: string;
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
  sshProxy: string;
  advancedOptions: string;
  sshProxyType: string;
  sshProxyNone: string;
  sshProxyHost: string;
  sshProxyPort: string;
  sshProxyUsername: string;
  sshProxyPassword: string;
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
  sshKeyBrowse: string;
  sshKeyBrowseTitle: string;
  sshKeyPlaceholderDefault: string;
  sshKeyPlaceholderAuto: string;
  sshKeyPlaceholderAgent: string;
  sshAgentBadge: string;
  sshAgentBadgeHint: string;
  sshUseDesktopKeyLadder: string;
  sshKeySourceRequired: string;
  sshAuthUsedAgentTitle: string;
  sshAuthUsedAgentBody: string;
  sshAuthUsedDefaultTitle: string;
  sshAuthUsedDefaultBody: string;
  drawerTabFiles: string;
  drawerTabProcesses: string;
  // File sidebar
  sidebarRefresh: string;
  sidebarNewFolder: string;
  sidebarUpload: string;
  sidebarToggleHidden: string;
  sidebarLockRoot: string;
  sidebarUnlockRoot: string;
  sidebarSwitchView: string;
  sidebarNewFolderPrompt: string;
  sidebarItems: string;
  sidebarInfoDirs: string;
  sidebarInfoFiles: string;
  sidebarMoveTitle: string;
  sidebarMoveConfirm: string;
  sidebarMoveCancel: string;
  sidebarMoveDest: string;
  sidebarEmptyDir: string;
  sidebarTreeMore: string;
  fileManager: string;
  ctxMenuOpen: string;
  ctxMenuSetAsRoot: string;
  ctxMenuOpenWith: string;
  ctxMenuBuiltinEditor: string;
  ctxMenuSystemDefault: string;
  ctxMenuDownloadN: string;
  ctxMenuDownloadFolder: string;
  ctxMenuDownload: string;
  ctxMenuUpload: string;
  ctxMenuUploadToFolder: string;
  ctxMenuUploadToCurrent: string;
  ctxMenuNewFile: string;
  ctxMenuNewFolder: string;
  ctxMenuCopyPath: string;
  ctxMenuCopyAbsPath: string;
  ctxMenuTerminalOps: string;
  ctxMenuCopyTo: string;
  ctxMenuCopyToN: string;
  ctxMenuMoveTo: string;
  ctxMenuMoveToN: string;
  ctxMenuSymlink: string;
  ctxMenuChmod: string;
  ctxMenuRename: string;
  ctxMenuDelete: string;
  ctxMenuDeleteN: string;
  ctxMenuProperties: string;
  ctxMenuMore: string;
  ctxMenuView: string;
  ctxMenuBookmark: string;
  ctxMenuRefresh: string;
  ctxMenuShowHidden: string;
  serverInfoToggle: string;
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
  aiLayoutSide: string;
  aiLayoutBottom: string;
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
  aiEnableThinking: string;
  aiEnableThinkingHint: string;
  aiThinkingOn: string;
  aiThinkingOff: string;
  aiAgentTrustLevel: string;
  aiAgentTrustManual: string;
  aiAgentTrustSemiAuto: string;
  aiAgentTrustFullAuto: string;
  aiAgentMaxIterations: string;
  aiAgentUnlimited: string;
  aiPermissionMode: string;
  aiPermissionModeAsk: string;
  aiPermissionModeAcceptSafe: string;
  aiPermissionModeAcceptAll: string;
  aiPermissionModePlan: string;
  aiPermissionModeBypass: string;
  aiPermissionModeHint: string;
  aiPermissionRules: string;
  aiPermissionRulesAdd: string;
  aiPermissionRulesNone: string;
  aiPermissionActionAllow: string;
  aiPermissionActionDeny: string;
  aiPermissionActionAsk: string;
  aiPermissionRuleTool: string;
  aiPermissionRuleCmdMatch: string;
  aiPermissionRulePathMatch: string;
  aiAuditLog: string;
  aiAuditLogOpen: string;
  aiAuditLogEmpty: string;
  aiAuditLogClose: string;
  aiAuditLogClear: string;
  aiAuditLogReload: string;
  aiAuditLogClearConfirm: string;
  aiNotifyWaitingTitle: string;
  aiNotifyCompleteTitle: string;
  aiNotifyCompleteBody: string;
  aiNotifyErrorTitle: string;
  aiNotifyErrorBody: string;
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
  aiNetworkRetry: string;
  aiContextCompressed: string;
  aiThinking: string;
  aiWorking: string;
  aiStopGenerating: string;
  aiSendToAgentConfirm: string;
  aiSendToAgentDontAsk: string;
  aiSendToAgentYes: string;
  aiSendToAgentNo: string;
  aiPlaceholderAgentMode: string;
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
  pairingAutoClose: string;
  pairingPaired: string;
  pairingAutoCloseIn: string;
  pairingMore: string;
  pairingToken: string;
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
  sshExportFailed: string;
  sshImportSuccess: string;
  sshImportFailed: string;
  sshImportInvalidFormat: string;
  sshImportCount: string;
  sshExportCount: string;
  sshExportMissingCredential: string;
  sshExportMobileUnsupported: string;
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
  remoteTokenExpired: string;
  remoteRepairBtn: string;
  remoteRepairWaiting: string;
  remoteRepairApproved: string;
  remoteRepairDenied: string;
  remoteInvalidUrl: string;
  remoteInvalidJson: string;
  remoteCredentialInUrlRejected: string;
  remoteSecurePairingUnavailable: string;
  remoteSecureTransportRequired: string;
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
  settingsLanAccess: string;
  settingsLanAccessHint: string;
  settingsDiscoverable: string;
  settingsLanDiscoveryHint: string;
  settingsLanPairingDisabled: string;
  settingsLanAccessDisableConfirm: string;
  settingsLanAccessDisableAction: string;
  settingsLanAccessError: string;
  connectedDevices: string;
  kickClient: string;
  kickAndBan: string;
  ipBanList: string;
  unbanIp: string;
  noConnectedDevices: string;
  pairedDeviceCredentials: string;
  noPairedDeviceCredentials: string;
  revokePairedDevice: string;
  confirmRevokePairedDevice: string;
  pairedDeviceCreated: string;
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
  revokePartialFailure: string;
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
  jsBypassProxy: string;
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
  deviceName: string;
  deviceNamePlaceholder: string;
  deviceAlias: string;
  deviceAliasPlaceholder: string;
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
  jsConnectingAuth: string;
  jsConnectingToken: string;
  jsConnectingAsset: string;
  jsLoadingAccounts: string;
  jsNoAccounts: string;
  jsSelectAccount: string;
  // ── JumpServer session expiration / logout ──
  jsSessionExpired: string;
  jsSessionExpiredDesc: string;
  jsReconnectAction: string;
  jsLogoutAction: string;
  jsLogoutConfirm: string;
  jsLoginRequired: string;
  jsReloginFailed: string;
  jsItemActionsTitle: string;
  jsCredentialPromptTitle: string;
  jsCredentialPromptDesc: string;
  jsCredentialPromptUsername: string;
  jsCredentialPromptPassword: string;
  jsCredentialPromptApiToken: string;
  jsCredentialPromptSubmit: string;
  jsCredentialStoredHint: string;
  jsCredentialAuthorityChanged: string;
  jsReturnToMainWindow: string;
  homeNewJumpServer: string;
  homeNewPhonePairing: string;
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
  editorMdPreview: string;
  editorMdPreviewOff: string;
  editorWordWrap: string;
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
    uiFontFamily: 'UI Font',
    cjkFontFamily: 'CJK Font',
    cjkFontAuto: 'System Default',
    enableNerdFont: 'Nerd Font Icons',
    enableLigatures: 'Ligatures',
    fontWeight: 'Font Weight',
    fontSharpness: 'Text Sharpening (may reduce scroll performance)',
    encoding: 'Encoding',
    fileManagerFontSize: 'File Manager Font Size',
    enableThumbnail: 'Session Thumbnail Preview',
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
    colorSchemeNeoBrutalism: 'Neo-Brutalism',
    colorSchemeNeoBrutalismRounded: 'Neo-Brutalism (Rounded)',
    nbPaletteTitle: 'Neo-Brutalism Palette',
    nbBg: 'Background',
    nbText: 'Text',
    nbBorder: 'Border',
    nbShadow: 'Shadow',
    nbAccent: 'Accent',
    nbHighlight: 'Highlight',
    nbSuccess: 'Success',
    nbInfo: 'Info',
    nbDanger: 'Danger',
    nbSurfaceAlt: 'Surface Alt',
    nbReset: 'Reset Palette',
    nbPresetSunset: '🌅 Sunset',
    nbPresetOcean: '🌊 Ocean',
    nbPresetSakura: '🌸 Sakura',
    nbPresetForest: '🌲 Forest',
    nbPresetLavender: '💜 Lavender',
    nbPresetMidnight: '🌙 Midnight',
    nbPresetCyber: '👾 Cyberpunk',
    nbPresetAbyss: '🌀 Abyss',
    nbPresetCandy: '🍬 Candy',
    nbPresetRetro: '📺 Retro',
    nbPresetNord: '❄️ Nord',
    nbPresetDracula: '🧛 Dracula',
    nbPresetSolarized: '☀️ Solarized',
    nbPresetOnyx: '🖤 Onyx',
    nbPresetEmber: '🔥 Ember',
    nbPresetMatrix: '💚 Matrix',
    nbPresetStealth: '🥷 Stealth',
    nbPresetMocha: '☕ Mocha',
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
    sshProxy: 'Proxy',
    advancedOptions: 'Advanced Options',
    sshProxyType: 'Proxy Type',
    sshProxyNone: 'Direct',
    sshProxyHost: 'Proxy Host',
    sshProxyPort: 'Port',
    sshProxyUsername: 'Username',
    sshProxyPassword: 'Password',
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
    sshKeyBrowse: 'Browse for private key file',
    sshKeyBrowseTitle: 'Select private key',
    sshKeyPlaceholderDefault: '~/.ssh/id_rsa  (leave empty to auto-detect)',
    sshKeyPlaceholderAuto: 'Leave empty to auto-use {path}',
    sshKeyPlaceholderAgent: 'Leave empty to use ssh-agent',
    sshAgentBadge: 'agent: {count}',
    sshAgentBadgeHint: 'ssh-agent is running and exposing this many identities. Leave the key path empty to use them.',
    sshUseDesktopKeyLadder: 'Use this Mac\'s ssh-agent or default ~/.ssh key (requires identity confirmation when saved)',
    sshKeySourceRequired: 'Choose a private key or explicitly enable the desktop ssh-agent/default-key option.',
    sshAuthUsedAgentTitle: 'Connected via ssh-agent',
    sshAuthUsedAgentBody: 'Authentication succeeded using a key from your running ssh-agent.',
    sshAuthUsedDefaultTitle: 'Connected via default key',
    sshAuthUsedDefaultBody: 'Authentication succeeded using a key in ~/.ssh/.',
    drawerTabFiles: 'Files',
    drawerTabProcesses: 'Processes',
    sidebarRefresh: 'Refresh',
    sidebarNewFolder: 'New folder',
    sidebarUpload: 'Upload',
    sidebarToggleHidden: 'Toggle hidden files',
    sidebarLockRoot: 'Unlock to follow terminal directory',
    sidebarUnlockRoot: 'Lock current directory',
    sidebarSwitchView: 'Switch view',
    sidebarNewFolderPrompt: 'Enter folder name:',
    sidebarItems: 'items',
    sidebarInfoDirs: 'folders',
    sidebarInfoFiles: 'files',
    sidebarMoveTitle: 'Move {count} item(s)?',
    sidebarMoveConfirm: 'Move',
    sidebarMoveCancel: 'Cancel',
    sidebarMoveDest: 'Destination',
    sidebarEmptyDir: 'Empty',
    sidebarTreeMore: '{n} more, click to load',
    fileManager: 'File Manager',
    ctxMenuOpen: 'Open',
    ctxMenuSetAsRoot: 'Set as Root',
    ctxMenuOpenWith: 'Open With',
    ctxMenuBuiltinEditor: 'Built-in Editor',
    ctxMenuSystemDefault: 'System Default',
    ctxMenuDownloadN: 'Download {count} Items',
    ctxMenuDownloadFolder: 'Download Folder',
    ctxMenuDownload: 'Download',
    ctxMenuUpload: 'Upload',
    ctxMenuUploadToFolder: 'Upload to This Folder',
    ctxMenuUploadToCurrent: 'Upload to Current Path',
    ctxMenuNewFile: 'New File',
    ctxMenuNewFolder: 'New Folder',
    ctxMenuCopyPath: 'Copy Path',
    ctxMenuCopyAbsPath: 'Copy Absolute Path',
    ctxMenuTerminalOps: 'Terminal Commands',
    ctxMenuCopyTo: 'Copy To...',
    ctxMenuCopyToN: 'Copy {count} Items To...',
    ctxMenuMoveTo: 'Move To...',
    ctxMenuMoveToN: 'Move {count} Items To...',
    ctxMenuSymlink: 'Create Symlink',
    ctxMenuChmod: 'Change Permissions',
    ctxMenuRename: 'Rename',
    ctxMenuDelete: 'Delete',
    ctxMenuDeleteN: 'Delete {count} Items',
    ctxMenuProperties: 'Properties',
    ctxMenuMore: 'More',
    ctxMenuView: 'View',
    ctxMenuBookmark: 'Bookmark Current Directory',
    ctxMenuRefresh: 'Refresh',
    ctxMenuShowHidden: 'Show Hidden Files',
    serverInfoToggle: 'Server Info',
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
    aiCapsule: 'MeAgent',
    aiBarOpacity: 'AI Bar Opacity',
    aiSendCommand: 'Send Command',
    aiSendPrompt: 'Send Prompt',
    aiModelSelect: 'Model',
    aiPlaceholderInput: 'Type a command or prompt...',
    aiPlaceholderCmd: 'Command ',
    aiPlaceholderAgent: ' Ask MeAgent... ',
    aiCollapse: 'Collapse',
    aiExpand: 'Expand',
    aiLayoutSide: 'Sidebar',
    aiLayoutBottom: 'Bottom',
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
    aiEnableThinking: 'Thinking Mode',
    aiEnableThinkingHint: 'Ask thinking-mode models (DeepSeek V4, Qwen3, GLM, MiMo, etc.) to reason before answering. Ignored by plain OpenAI / Anthropic / Gemini.',
    aiThinkingOn: 'Thinking on',
    aiThinkingOff: 'Thinking off',
    aiPermissionMode: 'Permission Mode',
    aiPermissionModeAsk: 'Ask every time',
    aiPermissionModeAcceptSafe: 'Accept safe',
    aiPermissionModeAcceptAll: 'Accept all',
    aiPermissionModePlan: 'Plan (read-only)',
    aiPermissionModeBypass: 'Bypass (no prompts)',
    aiPermissionModeHint: 'Overrides the trust level. Plan mode disables every write tool.',
    aiPermissionRules: 'Permission Rules',
    aiPermissionRulesAdd: 'Add rule',
    aiPermissionRulesNone: 'No custom rules. Defaults: deny writes to ~/.ssh & .env, allow read-only git/ls/cat.',
    aiPermissionActionAllow: 'Allow',
    aiPermissionActionDeny: 'Deny',
    aiPermissionActionAsk: 'Ask',
    aiPermissionRuleTool: 'Tool',
    aiPermissionRuleCmdMatch: 'Command regex',
    aiPermissionRulePathMatch: 'Path regex',
    aiAuditLog: 'Agent Audit Log',
    aiAuditLogOpen: 'Open audit log',
    aiAuditLogEmpty: '(No audit entries yet)',
    aiAuditLogClose: 'Close',
    aiAuditLogClear: 'Clear log',
    aiAuditLogReload: 'Reload',
    aiAuditLogClearConfirm: 'Clear all audit entries? This cannot be undone.',
    aiNotifyWaitingTitle: 'AI agent needs your attention',
    aiNotifyCompleteTitle: 'AI agent finished',
    aiNotifyCompleteBody: 'The agent turn completed.',
    aiNotifyErrorTitle: 'AI agent stopped with an error',
    aiNotifyErrorBody: 'The agent encountered an unrecoverable error.',
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
    aiNetworkRetry: 'Network blip, retrying',
    aiContextCompressed: 'Context compressed to fit model limits',
    aiThinking: 'Thinking',
    aiWorking: 'Working',
    aiStopGenerating: 'Stop',
    aiSendToAgentConfirm: 'This looks like a prompt. Send to MeAgent?',
    aiSendToAgentDontAsk: "Don't ask again, always send to MeAgent",
    aiSendToAgentYes: 'Send to Agent',
    aiSendToAgentNo: 'Send to Terminal',
    aiPlaceholderAgentMode: ' MeAgent ',
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
    aiSearxngEnable: 'Enable web search tool for MeAgent',
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
    pairingAutoClose: 'Auto-close after pairing',
    pairingPaired: '✓ Paired',
    pairingAutoCloseIn: 'closing in {n}s',
    pairingMore: 'Details / Copy',
    pairingToken: 'Token',
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
    sshExportFailed: 'Export was not completed. Identity confirmation may have been cancelled or rejected.',
    sshImportSuccess: 'Connections imported successfully',
    sshImportFailed: 'Import failed',
    sshImportInvalidFormat: 'Invalid file format',
    sshImportCount: 'connections imported',
    sshExportCount: 'connections exported',
    sshExportMissingCredential: '{count} connection(s) have no portable password/private key and cannot be used offline on mobile',
    sshExportMobileUnsupported: '{count} connection(s) were exported but current mobile direct SSH import will reject their proxy, credential format, or size',
    sshNoConnectionsToExport: 'No connections to export',
    homeRemoteConnect: 'Remote Connect',
    remoteConnectTitle: 'Remote Connect',
    remoteConnectSubtitle: 'Connect to a running MeTerm server on the network',
    remoteTabUrl: 'URL',
    remoteTabJson: 'JSON',
    remoteTabScan: 'Scan',
    remoteUrlPlaceholder: '192.168.1.10:8080 or https://host:port/',
    remoteJsonPlaceholder: 'Paste pairing JSON data here...',
    remoteConnectBtn: 'Connect',
    remoteConnecting: 'Connecting...',
    remoteConnected: 'Connected',
    remoteFailed: 'Connection failed',
    remoteTokenExpired: 'Token expired or revoked',
    remoteRepairBtn: 'Re-pair',
    remoteRepairWaiting: 'Waiting for approval...',
    remoteRepairApproved: 'Paired! Loading sessions...',
    remoteRepairDenied: 'Pairing denied or timed out',
    remoteInvalidUrl: 'Invalid address or missing token',
    remoteInvalidJson: 'Invalid JSON format',
    remoteCredentialInUrlRejected: 'Credentials in URLs are blocked. Enter the device token in the separate token field or pair again.',
    remoteSecurePairingUnavailable: 'Secure desktop pairing requires native certificate pinning and is unavailable here. Use the MeTerm mobile app.',
    remoteSecureTransportRequired: 'Remote credentials require HTTPS/WSS. Plaintext LAN connections are blocked.',
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
    settingsLanAccess: 'Allow LAN connections',
    settingsLanAccessHint: 'Turning this off disconnects LAN-direct sessions. Paired devices remain saved and relay connections are unaffected.',
    settingsDiscoverable: 'Advertise this computer on the LAN',
    settingsLanDiscoveryHint: 'Controls mDNS discovery only. Known, paired addresses can still connect while LAN access is enabled.',
    settingsLanPairingDisabled: 'Enable LAN connections before showing or copying pairing data.',
    settingsLanAccessDisableConfirm: 'Turn off LAN connections and disconnect current LAN-direct sessions? Relay sessions and paired-device records will remain.',
    settingsLanAccessDisableAction: 'Turn Off LAN Access',
    settingsLanAccessError: 'The LAN setting was not changed. The desktop kept the last confirmed secure state.',
    connectedDevices: 'Connected Devices',
    kickClient: 'Kick',
    kickAndBan: 'Kick & Ban',
    ipBanList: 'IP Ban List',
    unbanIp: 'Unban',
    noConnectedDevices: 'No connected devices',
    pairedDeviceCredentials: 'Paired Device Access',
    noPairedDeviceCredentials: 'No paired device credentials',
    revokePairedDevice: 'Revoke Access',
    confirmRevokePairedDevice: 'Revoke this device credential and disconnect it immediately?',
    pairedDeviceCreated: 'Paired',
    noBannedIps: 'No banned IPs',
    tokenManagement: 'Token Management',
    currentToken: 'Current Token',
    refreshToken: 'Refresh Token',
    tokenRefreshed: 'Token refreshed',
    customToken: 'Custom Token',
    customTokenPlaceholder: 'Enter 32-128 visible ASCII characters',
    customTokenTooShort: 'Use 32-128 visible ASCII characters without spaces',
    setToken: 'Set',
    revokeAllClients: 'Revoke All Paired Devices',
    confirmRevokeAll: 'This will revoke every paired device credential, disconnect remote devices, clear push registrations, and refresh the local owner token. All devices must pair again.',
    tokenSetSuccess: 'Token updated',
    revokeSuccess: 'Device access revoked',
    revokePartialFailure: 'Owner token refreshed, but device revocation failed. Retry.',
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
    jsBypassProxy: 'Bypass system proxy (for internal JumpServer)',
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
    deviceName: 'Device Name',
    deviceNamePlaceholder: 'Use OS hostname',
    deviceAlias: 'Alias',
    deviceAliasPlaceholder: 'Set a nickname',
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
    jsConnectingAuth: 'Authenticating with JumpServer...',
    jsConnectingToken: 'Requesting connection token...',
    jsConnectingAsset: 'Connecting to {name}...',
    jsLoadingAccounts: 'Loading accounts…',
    jsNoAccounts: 'No accounts available',
    jsSelectAccount: 'Select Account',
    jsSessionExpired: 'JumpServer session expired',
    jsSessionExpiredDesc: 'Please sign in again to continue. Existing terminal sessions are not affected.',
    jsReconnectAction: 'Sign in again',
    jsLogoutAction: 'Sign out',
    jsLogoutConfirm: 'Sign out of {name}? Existing terminal sessions will be preserved.',
    jsLoginRequired: 'Please sign in to JumpServer first',
    jsReloginFailed: 'Sign-in failed. Check your credentials and try again.',
    jsItemActionsTitle: 'Actions',
    jsCredentialPromptTitle: 'Sign in to JumpServer',
    jsCredentialPromptDesc: 'Credentials required for {name}. None found in Keychain — please enter them again.',
    jsCredentialPromptUsername: 'Username',
    jsCredentialPromptPassword: 'Password',
    jsCredentialPromptApiToken: 'API Token',
    jsCredentialPromptSubmit: 'Sign in',
    jsCredentialStoredHint: 'Saved securely — leave blank to keep it',
    jsCredentialAuthorityChanged: 'Server, account, or proxy changed. Re-enter the primary credential before saving.',
    jsReturnToMainWindow: 'Return to main window',
    homeNewJumpServer: 'JumpServer',
    homeNewPhonePairing: 'Pair Phone',
    jsSaveAndConnect: 'Save & Connect',
    homeSearchPlaceholder: 'Search connections, commands or docs',
    homeGroupDefault: 'Default',
    homeGroupUngrouped: 'Recent',
    homeGroupManage: 'Manage Groups',
    homeGroupNew: 'New Group',
    homeGroupRename: 'Rename',
    homeGroupDelete: 'Delete Group',
    homeGroupDeleteConfirm: 'Delete this group? Connections will be moved to Recent.',
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
    editorMdPreview: 'Preview',
    editorMdPreviewOff: 'Hide Preview',
    editorWordWrap: 'Wrap',
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
    uiFontFamily: '界面字体',
    cjkFontFamily: '中文字体',
    cjkFontAuto: '系统默认',
    enableNerdFont: 'Nerd Font 图标',
    enableLigatures: '编程连字',
    fontWeight: '字重',
    fontSharpness: '文字锐化（可能影响滚动流畅度）',
    encoding: '字符编码',
    fileManagerFontSize: '文件管理器字体大小',
    enableThumbnail: '会话缩略图预览',
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
    colorSchemeNeoBrutalism: '新粗野主义',
    colorSchemeNeoBrutalismRounded: '新粗野主义 (圆角)',
    nbPaletteTitle: '新粗野主义配色',
    nbBg: '主背景',
    nbText: '主文字',
    nbBorder: '边框',
    nbShadow: '阴影',
    nbAccent: '强调色',
    nbHighlight: '高亮色',
    nbSuccess: '成功',
    nbInfo: '信息',
    nbDanger: '危险',
    nbSurfaceAlt: '辅助背景',
    nbReset: '重置配色',
    nbPresetSunset: '🌅 日落',
    nbPresetOcean: '🌊 海洋',
    nbPresetSakura: '🌸 樱花',
    nbPresetForest: '🌲 森林',
    nbPresetLavender: '💜 薰衣草',
    nbPresetMidnight: '🌙 午夜',
    nbPresetCyber: '👾 赛博朋克',
    nbPresetAbyss: '🌀 深渊',
    nbPresetCandy: '🍬 糖果',
    nbPresetRetro: '📺 复古',
    nbPresetNord: '❄️ 极光',
    nbPresetDracula: '🧛 德古拉',
    nbPresetSolarized: '☀️ 曝光',
    nbPresetOnyx: '🖤 玛瑙黑',
    nbPresetEmber: '🔥 余烬',
    nbPresetMatrix: '💚 矩阵',
    nbPresetStealth: '🥷 隐匿',
    nbPresetMocha: '☕ 摩卡',
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
    sshProxy: '代理',
    advancedOptions: '高级选项',
    sshProxyType: '代理类型',
    sshProxyNone: '直连',
    sshProxyHost: '代理地址',
    sshProxyPort: '端口',
    sshProxyUsername: '用户名',
    sshProxyPassword: '密码',
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
    sshKeyBrowse: '浏览私钥文件',
    sshKeyBrowseTitle: '选择私钥',
    sshKeyPlaceholderDefault: '~/.ssh/id_rsa  (留空可自动检测)',
    sshKeyPlaceholderAuto: '留空将自动使用 {path}',
    sshKeyPlaceholderAgent: '留空将通过 ssh-agent 认证',
    sshAgentBadge: 'agent: {count}',
    sshAgentBadgeHint: 'ssh-agent 已就绪，里面有这些已加载的身份。留空密钥路径即可使用。',
    sshUseDesktopKeyLadder: '使用本机 ssh-agent 或 ~/.ssh 默认密钥（保存时需身份确认）',
    sshKeySourceRequired: '请选择私钥，或明确启用本机 ssh-agent/默认密钥选项。',
    sshAuthUsedAgentTitle: '已通过 ssh-agent 连接',
    sshAuthUsedAgentBody: '使用 ssh-agent 中的密钥完成了认证。',
    sshAuthUsedDefaultTitle: '已通过默认密钥连接',
    sshAuthUsedDefaultBody: '使用 ~/.ssh/ 下的默认密钥完成了认证。',
    drawerTabFiles: '文件',
    drawerTabProcesses: '进程',
    sidebarRefresh: '刷新',
    sidebarNewFolder: '新建文件夹',
    sidebarUpload: '上传',
    sidebarToggleHidden: '显示/隐藏文件',
    sidebarLockRoot: '解锁以跟随终端目录',
    sidebarUnlockRoot: '锁定当前目录',
    sidebarSwitchView: '切换视图',
    sidebarNewFolderPrompt: '请输入文件夹名称：',
    sidebarItems: '项',
    sidebarInfoDirs: '个文件夹',
    sidebarInfoFiles: '个文件',
    sidebarMoveTitle: '移动 {count} 个项目？',
    sidebarMoveConfirm: '移动',
    sidebarMoveCancel: '取消',
    sidebarMoveDest: '目标位置',
    sidebarEmptyDir: '空目录',
    sidebarTreeMore: '还有 {n} 项,点击加载',
    fileManager: '文件管理',
    ctxMenuOpen: '打开',
    ctxMenuSetAsRoot: '设为根目录',
    ctxMenuOpenWith: '打开方式',
    ctxMenuBuiltinEditor: '内置编辑器',
    ctxMenuSystemDefault: '系统默认',
    ctxMenuDownloadN: '下载 {count} 个文件',
    ctxMenuDownloadFolder: '下载文件夹',
    ctxMenuDownload: '下载',
    ctxMenuUpload: '上传',
    ctxMenuUploadToFolder: '上传到此文件夹',
    ctxMenuUploadToCurrent: '上传到当前路径',
    ctxMenuNewFile: '新建文件',
    ctxMenuNewFolder: '新建文件夹',
    ctxMenuCopyPath: '复制路径',
    ctxMenuCopyAbsPath: '复制绝对路径',
    ctxMenuTerminalOps: '终端操作',
    ctxMenuCopyTo: '复制到...',
    ctxMenuCopyToN: '复制 {count} 个文件到...',
    ctxMenuMoveTo: '移动到...',
    ctxMenuMoveToN: '移动 {count} 个文件到...',
    ctxMenuSymlink: '创建符号链接',
    ctxMenuChmod: '修改权限',
    ctxMenuRename: '重命名',
    ctxMenuDelete: '删除',
    ctxMenuDeleteN: '删除 {count} 个文件',
    ctxMenuProperties: '详情',
    ctxMenuMore: '更多',
    ctxMenuView: '视图',
    ctxMenuBookmark: '收藏当前目录',
    ctxMenuRefresh: '刷新',
    ctxMenuShowHidden: '显示隐藏文件',
    serverInfoToggle: '服务器信息',
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
    aiCapsule: 'MeAgent',
    aiBarOpacity: 'AI 栏透明度',
    aiSendCommand: '发送命令',
    aiSendPrompt: '发送提示词',
    aiModelSelect: '模型',
    aiPlaceholderInput: '输入命令或提示词...',
    aiPlaceholderCmd: '命令 ',
    aiPlaceholderAgent: ' 询问 MeAgent... ',
    aiCollapse: '收起',
    aiExpand: '展开',
    aiLayoutSide: '侧边栏',
    aiLayoutBottom: '底部',
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
    aiEnableThinking: '思考模式',
    aiEnableThinkingHint: '启用后会让支持思考模式的模型（DeepSeek V4、Qwen3、GLM、MiMo 等）先推理再回答。OpenAI / Anthropic / Gemini 等不支持此参数的厂商会忽略。',
    aiThinkingOn: '思考已开启',
    aiThinkingOff: '思考已关闭',
    aiPermissionMode: '权限模式',
    aiPermissionModeAsk: '每次询问',
    aiPermissionModeAcceptSafe: '接受安全操作',
    aiPermissionModeAcceptAll: '全部接受',
    aiPermissionModePlan: '计划模式(只读)',
    aiPermissionModeBypass: '绕过(不提示)',
    aiPermissionModeHint: '覆盖信任级别。计划模式禁用所有写入工具。',
    aiPermissionRules: '权限规则',
    aiPermissionRulesAdd: '添加规则',
    aiPermissionRulesNone: '无自定义规则。默认:禁止写入 ~/.ssh 和 .env,允许只读的 git/ls/cat。',
    aiPermissionActionAllow: '允许',
    aiPermissionActionDeny: '拒绝',
    aiPermissionActionAsk: '询问',
    aiPermissionRuleTool: '工具',
    aiPermissionRuleCmdMatch: '命令正则',
    aiPermissionRulePathMatch: '路径正则',
    aiAuditLog: 'Agent 审计日志',
    aiAuditLogOpen: '查看审计日志',
    aiAuditLogEmpty: '(暂无审计记录)',
    aiAuditLogClose: '关闭',
    aiAuditLogClear: '清空日志',
    aiAuditLogReload: '刷新',
    aiAuditLogClearConfirm: '确定清空所有审计记录?此操作不可撤销。',
    aiNotifyWaitingTitle: 'AI Agent 需要确认',
    aiNotifyCompleteTitle: 'AI Agent 已完成',
    aiNotifyCompleteBody: 'Agent 已完成当前任务。',
    aiNotifyErrorTitle: 'AI Agent 遇到错误',
    aiNotifyErrorBody: 'Agent 执行中止,请查看详情。',
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
    aiNetworkRetry: '网络异常，正在重试',
    aiContextCompressed: '上下文已压缩以适应模型限制',
    aiThinking: '思考中',
    aiWorking: '工作中',
    aiStopGenerating: '停止',
    aiSendToAgentConfirm: '这看起来是提示词，发送给 MeAgent？',
    aiSendToAgentDontAsk: '不再询问，默认发送至 MeAgent',
    aiSendToAgentYes: '发送给 Agent',
    aiSendToAgentNo: '发送到终端',
    aiPlaceholderAgentMode: ' MeAgent ',
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
    aiSearxngEnable: '为 MeAgent 启用网络搜索工具',
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
    pairingAutoClose: '配对成功后自动关闭',
    pairingPaired: '✓ 已配对',
    pairingAutoCloseIn: '{n} 秒后自动关闭',
    pairingMore: '详情 / 复制',
    pairingToken: '令牌',
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
    sshExportFailed: '导出未完成，身份确认可能已取消或被系统拒绝。',
    sshImportSuccess: '连接导入成功',
    sshImportFailed: '导入失败',
    sshImportInvalidFormat: '文件格式无效',
    sshImportCount: '个连接已导入',
    sshExportCount: '个连接已导出',
    sshExportMissingCredential: '其中 {count} 个连接没有可迁移的密码或私钥，无法在手机离线直连',
    sshExportMobileUnsupported: '其中 {count} 个连接已导出，但其代理、凭据格式或大小不受当前手机直连导入支持',
    sshNoConnectionsToExport: '没有可导出的连接',
    homeRemoteConnect: '远程连接',
    remoteConnectTitle: '远程连接',
    remoteConnectSubtitle: '连接到网络中运行的 MeTerm 服务端',
    remoteTabUrl: 'URL',
    remoteTabJson: 'JSON',
    remoteTabScan: '扫描',
    remoteUrlPlaceholder: '192.168.1.10:8080 或 https://host:port/',
    remoteJsonPlaceholder: '在此粘贴配对 JSON 数据...',
    remoteConnectBtn: '连接',
    remoteConnecting: '连接中...',
    remoteConnected: '已连接',
    remoteFailed: '连接失败',
    remoteTokenExpired: '令牌已过期或被撤销',
    remoteRepairBtn: '重新配对',
    remoteRepairWaiting: '等待对方批准...',
    remoteRepairApproved: '已配对！加载会话...',
    remoteRepairDenied: '配对被拒绝或超时',
    remoteInvalidUrl: '地址无效或缺少令牌',
    remoteInvalidJson: 'JSON 格式无效',
    remoteCredentialInUrlRejected: '已拦截 URL 中的凭据。请在独立令牌输入框中填写设备令牌，或重新配对。',
    remoteSecurePairingUnavailable: '安全的桌面间配对需要原生证书指纹固定，当前入口暂不可用。请使用 MeTerm 手机端配对。',
    remoteSecureTransportRequired: '远程凭据必须通过 HTTPS/WSS 传输，已拦截局域网明文连接。',
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
    settingsLanAccess: '允许局域网连接',
    settingsLanAccessHint: '关闭后将断开局域网直连会话；已配对设备仍会保留，中继连接不受影响。',
    settingsDiscoverable: '在局域网中广播此电脑',
    settingsLanDiscoveryHint: '仅控制 mDNS 发现。局域网访问开启时，已配对设备仍可通过已知地址连接。',
    settingsLanPairingDisabled: '请先开启局域网连接，再显示或复制配对数据。',
    settingsLanAccessDisableConfirm: '确定关闭局域网连接并断开当前局域网直连会话吗？中继会话和已配对设备记录会保留。',
    settingsLanAccessDisableAction: '关闭局域网连接',
    settingsLanAccessError: '局域网设置未改变，桌面端已保留最后一次确认的安全状态。',
    connectedDevices: '已连接设备',
    kickClient: '踢出',
    kickAndBan: '踢出并封禁',
    ipBanList: 'IP 封禁列表',
    unbanIp: '解封',
    noConnectedDevices: '暂无连接设备',
    pairedDeviceCredentials: '已配对设备权限',
    noPairedDeviceCredentials: '暂无已配对设备凭据',
    revokePairedDevice: '撤销权限',
    confirmRevokePairedDevice: '撤销该设备凭据并立即断开它的所有连接？',
    pairedDeviceCreated: '配对时间',
    noBannedIps: '暂无封禁 IP',
    tokenManagement: 'Token 管理',
    currentToken: '当前 Token',
    refreshToken: '刷新 Token',
    tokenRefreshed: 'Token 已刷新',
    customToken: '自定义 Token',
    customTokenPlaceholder: '输入 32-128 个可见 ASCII 字符',
    customTokenTooShort: '请使用 32-128 个不含空格的可见 ASCII 字符',
    setToken: '设置',
    revokeAllClients: '撤销所有已配对设备',
    confirmRevokeAll: '这将撤销全部设备凭据、断开远程设备、清除推送注册并刷新本机 owner token。所有设备均需重新配对。',
    tokenSetSuccess: 'Token 已更新',
    revokeSuccess: '设备权限已撤销',
    revokePartialFailure: 'Owner Token 已刷新，但设备权限撤销失败，请重试',
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
    jsBypassProxy: '绕过系统代理（内网 JumpServer）',
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
    deviceName: '设备名称',
    deviceNamePlaceholder: '使用系统主机名',
    deviceAlias: '别名',
    deviceAliasPlaceholder: '设置昵称',
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
    jsConnectingAuth: '正在向 JumpServer 认证...',
    jsConnectingToken: '正在获取连接令牌...',
    jsConnectingAsset: '正在连接到 {name}...',
    jsLoadingAccounts: '加载账户中…',
    jsNoAccounts: '没有可用账户',
    jsSelectAccount: '选择账户',
    jsSessionExpired: 'JumpServer 会话已过期',
    jsSessionExpiredDesc: '请重新登录以继续使用资产浏览器。已打开的终端会话不受影响。',
    jsReconnectAction: '重新登录',
    jsLogoutAction: '退出登录',
    jsLogoutConfirm: '退出登录 {name}？已打开的终端会话会保留。',
    jsLoginRequired: '请先重新登录 JumpServer',
    jsReloginFailed: '登录失败，请检查凭据后重试。',
    jsItemActionsTitle: '操作',
    jsCredentialPromptTitle: '登录 JumpServer',
    jsCredentialPromptDesc: '需要凭据以连接 {name}。Keychain 中暂无该连接凭据，请重新输入。',
    jsCredentialPromptUsername: '用户名',
    jsCredentialPromptPassword: '密码',
    jsCredentialPromptApiToken: 'API Token',
    jsCredentialPromptSubmit: '登录',
    jsCredentialStoredHint: '已安全保存，留空可保留原凭据',
    jsCredentialAuthorityChanged: '服务器、账户或代理已变更，请重新输入主凭据后再保存。',
    jsReturnToMainWindow: '返回主窗口',
    homeNewJumpServer: 'JumpServer',
    homeNewPhonePairing: '手机配对',
    jsSaveAndConnect: '保存并连接',
    homeSearchPlaceholder: '搜索连接、指令或文档',
    homeGroupDefault: '默认',
    homeGroupUngrouped: '最近',
    homeGroupManage: '管理分组',
    homeGroupNew: '新建分组',
    homeGroupRename: '重命名',
    homeGroupDelete: '删除分组',
    homeGroupDeleteConfirm: '删除该分组？连接将移至最近。',
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
    editorMdPreview: '预览',
    editorMdPreviewOff: '关闭预览',
    editorWordWrap: '换行',
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
