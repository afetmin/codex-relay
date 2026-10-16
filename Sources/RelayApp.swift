import AppKit
import Foundation
import Darwin

final class RelayApp: NSObject, NSApplicationDelegate, NSTableViewDataSource, NSTableViewDelegate, NSMenuDelegate, NSWindowDelegate, NSSearchFieldDelegate {
    private var statusItem: NSStatusItem!
    private var helper: Process?
    private var input: FileHandle?
    private var outputBuffer = Data()
    private let readQueue = DispatchQueue(label: "relay.helper.output")
    private var state: [String: Any] = [:]
    private var tasks: [[String: Any]] = []
    private var allTasks: [[String: Any]] = []
    private var searchField: NSSearchField?
    private var window: NSWindow?
    private var table: NSTableView!
    private var summary: NSTextField!
    private var detail: NSTextField!
    private var enabledButton: NSButton!
    private var promptField: NSTextField!
    private var logWindow: NSWindow?
    private var logText: NSTextView?
    private var didQuit = false
    private var restartTimer: Timer?
    private var busyEditing = false
    private var menuTracking = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.image = NSImage(systemSymbolName: "arrow.trianglehead.2.clockwise.rotate.90", accessibilityDescription: "Codex Relay")
        if statusItem.button?.image == nil { statusItem.button?.image = NSImage(systemSymbolName: "arrow.triangle.2.circlepath", accessibilityDescription: "Codex Relay") }
        statusItem.button?.image?.isTemplate = true
        statusItem.button?.imagePosition = .imageLeading
        rebuildMenu()
        startHelper()
        if CommandLine.arguments.contains("--show") || !UserDefaults.standard.bool(forKey: "hasOpened") {
            showManager(nil)
            UserDefaults.standard.set(true, forKey: "hasOpened")
        }
    }

    private func nodePath() -> String? {
        let candidates = [ProcessInfo.processInfo.environment["CODEX_RELAY_NODE"], "/opt/homebrew/bin/node", "/usr/local/bin/node", "/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node"].compactMap { $0 }
        return candidates.first { FileManager.default.isExecutableFile(atPath: $0) }
    }

    private func startHelper() {
        guard !didQuit else { return }
        guard let node = nodePath(), let script = Bundle.main.path(forResource: "monitor", ofType: "mjs") else {
            state = ["error": "未找到 Node.js。请安装 Node.js 22 或更新版本后重新打开。"]
            render()
            return
        }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: node)
        process.arguments = [script, "--stdio"]
        process.environment = ProcessInfo.processInfo.environment.merging(["CODEX_RELAY_PARENT_PID": String(ProcessInfo.processInfo.processIdentifier)]) { _, new in new }
        let stdin = Pipe(), stdout = Pipe(), stderr = Pipe()
        process.standardInput = stdin
        process.standardOutput = stdout
        process.standardError = stderr
        input = stdin.fileHandleForWriting
        stdout.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty else { return }
            self?.readQueue.async { [weak self] in self?.consume(data) }
        }
        stderr.fileHandleForReading.readabilityHandler = { handle in _ = handle.availableData }
        process.terminationHandler = { [weak self] process in
            DispatchQueue.main.async {
                guard let self, !self.didQuit else { return }
                stdout.fileHandleForReading.readabilityHandler = nil
                self.state["connected"] = false
                self.state["error"] = "监控进程已退出（\(process.terminationStatus)），5 秒后重新连接。"
                self.render()
                self.restartTimer = Timer.scheduledTimer(withTimeInterval: 5, repeats: false) { [weak self] _ in self?.startHelper() }
            }
        }
        do { try process.run(); helper = process } catch {
            state = ["error": "启动失败：\(error.localizedDescription)"]
            render()
        }
    }

    private func consume(_ data: Data) {
        outputBuffer.append(data)
        while let index = outputBuffer.firstIndex(of: 10) {
            let line = outputBuffer.prefix(upTo: index)
            outputBuffer.removeSubrange(...index)
            guard let parsed = try? JSONSerialization.jsonObject(with: line) as? [String: Any] else { continue }
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                if parsed["type"] as? String == "state" {
                    self.state = parsed
                    self.allTasks = parsed["tasks"] as? [[String: Any]] ?? []
                    self.render()
                }
            }
        }
    }

    private func send(_ command: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: command) else { return }
        do { try input?.write(contentsOf: data + Data([10])) } catch {
            state["error"] = "无法联系监控进程，正在重新连接。"
            render()
        }
    }

    private func item(_ title: String, _ action: Selector? = nil) -> NSMenuItem {
        let result = NSMenuItem(title: title, action: action, keyEquivalent: "")
        result.target = self
        return result
    }

    private func rebuildMenu() {
        let menu = NSMenu()
        menu.delegate = self
        menu.addItem(item("Codex Relay"))
        menu.addItem(item(quotaSummary()))
        if let error = state["error"] as? String, !error.isEmpty { menu.addItem(item(String(error.prefix(90)))) }
        menu.addItem(.separator())
        menu.addItem(item("选择监控任务…", #selector(showManager)))
        let toggle = item(state["enabled"] as? Bool == false ? "恢复监控" : "暂停全部监控", #selector(toggleEnabled))
        toggle.isEnabled = helper?.isRunning == true
        menu.addItem(toggle)
        let watched = allTasks.filter { $0["watched"] as? Bool == true }
        if !watched.isEmpty {
            menu.addItem(.separator())
            for task in watched {
                let submenu = NSMenu()
                let title = task["title"] as? String ?? "未命名任务"
                submenu.addItem(item(task["label"] as? String ?? "监控中"))
                let open = item("在 Codex 中打开", #selector(openTask))
                open.representedObject = task["id"]
                submenu.addItem(open)
                let stop = item("取消监控", #selector(unwatchTask))
                stop.representedObject = task["id"]
                submenu.addItem(stop)
                let row = item(String(title.prefix(46)))
                row.submenu = submenu
                menu.addItem(row)
            }
        }
        menu.addItem(.separator())
        menu.addItem(item("立即检查", #selector(refresh)))
        menu.addItem(item("查看运行记录…", #selector(showLogs)))
        menu.addItem(item("使用说明…", #selector(showHelp)))
        menu.addItem(.separator())
        menu.addItem(item("退出 Codex Relay", #selector(quit)))
        statusItem.menu = menu
        statusItem.button?.title = watched.isEmpty ? "" : " \(watched.count)"
        statusItem.button?.toolTip = "Codex Relay · \(quotaSummary())"
    }

    func menuWillOpen(_ menu: NSMenu) { menuTracking = true; send(["command": "refresh"]) }
    func menuDidClose(_ menu: NSMenu) { menuTracking = false; rebuildMenu() }

    private func quotaSummary() -> String {
        guard let quota = state["quota"] as? [String: Any] else { return state["connected"] as? Bool == true ? "正在读取额度…" : "等待 Codex 连接" }
        var parts: [String] = []
        for key in ["primary", "secondary"] {
            guard let window = quota[key] as? [String: Any], let used = window["usedPercent"] as? Double else { continue }
            let mins = window["windowDurationMins"] as? Int ?? 0
            let name = mins == 300 ? "5 小时" : mins == 10080 ? "每周" : "\(mins) 分钟"
            parts.append("\(name)剩余 \(max(0, 100 - Int(used)))%")
        }
        return parts.isEmpty ? "额度状态未知，暂不续跑" : parts.joined(separator: " · ")
    }

    private func render() {
        let query = searchField?.stringValue.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        tasks = query.isEmpty ? allTasks : allTasks.filter { task in
            [task["title"] as? String ?? "", task["cwd"] as? String ?? ""].contains { $0.localizedCaseInsensitiveContains(query) }
        }
        if !menuTracking { rebuildMenu() }
        summary?.stringValue = quotaSummary()
        let error = state["error"] as? String ?? ""
        detail?.stringValue = error.isEmpty ? (state["description"] as? String ?? "连接后选择任务。只有明确因额度中断的任务会自动继续。") : error
        enabledButton?.state = state["enabled"] as? Bool == false ? .off : .on
        if !busyEditing { promptField?.stringValue = state["prompt"] as? String ?? "继续完成之前未完成的任务。" }
        let selected = table?.selectedRowIndexes ?? IndexSet()
        table?.reloadData()
        table?.selectRowIndexes(selected.filter { $0 < tasks.count }.reduce(into: IndexSet()) { $0.insert($1) }, byExtendingSelection: false)
        if let logText {
            let logs = state["events"] as? [[String: Any]] ?? []
            logText.string = logs.isEmpty ? "暂无运行记录。选择任务后，开始监控、暂停和续跑结果会记录在这里。" : logs.reversed().map { event in
                let date = Date(timeIntervalSince1970: (event["at"] as? Double ?? 0) / 1000)
                let formatter = DateFormatter(); formatter.dateFormat = "MM-dd HH:mm:ss"
                return "\(formatter.string(from: date))  \(event["message"] as? String ?? "")"
            }.joined(separator: "\n\n")
        }
    }

    @objc private func showManager(_ sender: Any?) {
        if let window { NSApp.activate(ignoringOtherApps: true); window.makeKeyAndOrderFront(nil); return }
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 790, height: 540), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "Codex Relay — 任务监控"
        window.minSize = NSSize(width: 650, height: 450)
        window.isReleasedWhenClosed = false
        window.delegate = self
        self.window = window
        let content = window.contentView!
        let stack = NSStackView()
        stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 12
        stack.translatesAutoresizingMaskIntoConstraints = false
        content.addSubview(stack)
        NSLayoutConstraint.activate([stack.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 22), stack.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -22), stack.topAnchor.constraint(equalTo: content.topAnchor, constant: 20), stack.bottomAnchor.constraint(equalTo: content.bottomAnchor, constant: -20)])
        summary = NSTextField(labelWithString: quotaSummary()); summary.font = .systemFont(ofSize: 18, weight: .semibold)
        stack.addArrangedSubview(summary)
        detail = NSTextField(wrappingLabelWithString: "正在连接 Codex…"); detail.textColor = .secondaryLabelColor
        stack.addArrangedSubview(detail)
        let instruction = NSTextField(labelWithString: "勾选要持续监控的任务。关闭窗口后，菜单栏应用会继续运行。")
        stack.addArrangedSubview(instruction)
        let search = NSSearchField(); search.placeholderString = "搜索任务名称或项目路径"; search.delegate = self
        searchField = search; stack.addArrangedSubview(search)
        search.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        table = NSTableView(); table.delegate = self; table.dataSource = self; table.rowHeight = 42
        table.usesAlternatingRowBackgroundColors = true; table.allowsMultipleSelection = false
        for (id, title, width) in [("watch", "监控", 48.0), ("title", "任务", 390.0), ("status", "监控状态", 250.0)] {
            let column = NSTableColumn(identifier: NSUserInterfaceItemIdentifier(id)); column.title = title; column.width = width; column.minWidth = id == "title" ? 180 : width
            if id == "title" { column.resizingMask = .autoresizingMask } else { column.resizingMask = .userResizingMask }
            table.addTableColumn(column)
        }
        table.columnAutoresizingStyle = .lastColumnOnlyAutoresizingStyle
        table.target = self; table.doubleAction = #selector(openSelectedTask)
        let scroll = NSScrollView(); scroll.hasVerticalScroller = true; scroll.borderType = .bezelBorder; scroll.documentView = table
        stack.addArrangedSubview(scroll)
        scroll.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        scroll.heightAnchor.constraint(greaterThanOrEqualToConstant: 170).isActive = true
        let promptLabel = NSTextField(labelWithString: "续跑时发送的消息")
        promptLabel.font = .systemFont(ofSize: 12, weight: .medium); stack.addArrangedSubview(promptLabel)
        let promptRow = NSStackView(); promptRow.orientation = .horizontal; promptRow.spacing = 8
        promptField = NSTextField(string: state["prompt"] as? String ?? "继续完成之前未完成的任务。")
        promptField.placeholderString = "继续完成之前未完成的任务。"
        promptField.target = self; promptField.action = #selector(savePrompt)
        promptField.delegate = self
        promptRow.addArrangedSubview(promptField)
        let save = NSButton(title: "保存消息", target: self, action: #selector(savePrompt)); promptRow.addArrangedSubview(save)
        stack.addArrangedSubview(promptRow); promptRow.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        let footer = NSStackView(); footer.orientation = .horizontal; footer.spacing = 12
        enabledButton = NSButton(checkboxWithTitle: "启用自动续跑", target: self, action: #selector(setEnabled))
        enabledButton.state = state["enabled"] as? Bool == false ? .off : .on
        footer.addArrangedSubview(enabledButton)
        let spacer = NSView(); spacer.setContentHuggingPriority(.defaultLow, for: .horizontal); footer.addArrangedSubview(spacer)
        footer.addArrangedSubview(NSButton(title: "运行记录…", target: self, action: #selector(showLogs)))
        footer.addArrangedSubview(NSButton(title: "立即检查", target: self, action: #selector(refresh)))
        stack.addArrangedSubview(footer); footer.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        render(); window.center(); NSApp.activate(ignoringOtherApps: true); window.makeKeyAndOrderFront(nil)
        send(["command": "refresh"])
    }

    func numberOfRows(in tableView: NSTableView) -> Int { tasks.count }
    func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
        guard row < tasks.count else { return nil }
        let task = tasks[row]
        let cell = NSTableCellView()
        if tableColumn?.identifier.rawValue == "watch" {
            let checkbox = NSButton(checkboxWithTitle: "", target: self, action: #selector(toggleWatch))
            checkbox.tag = row; checkbox.state = task["watched"] as? Bool == true ? .on : .off
            checkbox.setAccessibilityLabel("监控 \(task["title"] as? String ?? "任务")")
            checkbox.translatesAutoresizingMaskIntoConstraints = false
            cell.addSubview(checkbox)
            NSLayoutConstraint.activate([
                checkbox.centerXAnchor.constraint(equalTo: cell.centerXAnchor),
                checkbox.centerYAnchor.constraint(equalTo: cell.centerYAnchor)
            ])
            return cell
        }
        let label = NSTextField(labelWithString: tableColumn?.identifier.rawValue == "title" ? (task["title"] as? String ?? "未命名任务") : (task["label"] as? String ?? "未知"))
        label.lineBreakMode = .byTruncatingTail
        label.toolTip = "\(task["title"] as? String ?? "")\n\(task["id"] as? String ?? "")\n\(task["label"] as? String ?? "")"
        label.textColor = tableColumn?.identifier.rawValue == "title" ? .labelColor : .secondaryLabelColor
        label.translatesAutoresizingMaskIntoConstraints = false
        cell.addSubview(label)
        cell.textField = label
        NSLayoutConstraint.activate([
            label.leadingAnchor.constraint(equalTo: cell.leadingAnchor),
            label.trailingAnchor.constraint(equalTo: cell.trailingAnchor),
            label.centerYAnchor.constraint(equalTo: cell.centerYAnchor)
        ])
        return cell
    }

    @objc private func toggleWatch(_ sender: NSButton) {
        guard sender.tag < tasks.count, let id = tasks[sender.tag]["id"] as? String else { return }
        send(["command": "watch", "threadId": id, "enabled": sender.state == .on])
    }
    @objc private func unwatchTask(_ sender: NSMenuItem) { if let id = sender.representedObject as? String { send(["command": "watch", "threadId": id, "enabled": false]) } }
    @objc private func toggleEnabled(_ sender: Any?) { send(["command": "setEnabled", "value": state["enabled"] as? Bool == false]) }
    @objc private func setEnabled(_ sender: NSButton) { send(["command": "setEnabled", "value": sender.state == .on]) }
    @objc private func refresh(_ sender: Any?) { send(["command": "refresh"]) }
    @objc private func savePrompt(_ sender: Any?) {
        let value = promptField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        if !value.isEmpty { send(["command": "configure", "prompt": value]) }
        window?.makeFirstResponder(nil)
        busyEditing = false
    }
    func controlTextDidBeginEditing(_ notification: Notification) { if notification.object as? NSTextField === promptField { busyEditing = true } }
    func controlTextDidEndEditing(_ notification: Notification) { if notification.object as? NSTextField === promptField { busyEditing = false } }
    func controlTextDidChange(_ notification: Notification) { if notification.object as? NSSearchField === searchField { render() } }
    @objc private func openTask(_ sender: NSMenuItem) { if let id = sender.representedObject as? String { openConversation(id) } }
    @objc private func openSelectedTask(_ sender: Any?) { let row = table.selectedRow; if row >= 0, row < tasks.count, let id = tasks[row]["id"] as? String { openConversation(id) } }
    private func openConversation(_ id: String) { if let url = URL(string: "codex://threads/\(id)") { NSWorkspace.shared.open(url) } }

    @objc private func showLogs(_ sender: Any?) {
        if let logWindow { NSApp.activate(ignoringOtherApps: true); logWindow.makeKeyAndOrderFront(nil); render(); return }
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 740, height: 460), styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
        window.title = "Codex Relay — 运行记录"; window.isReleasedWhenClosed = false
        let scroll = NSScrollView(frame: window.contentView!.bounds); scroll.autoresizingMask = [.width, .height]; scroll.hasVerticalScroller = true
        let text = NSTextView(frame: scroll.bounds); text.isEditable = false; text.autoresizingMask = [.width]; text.font = .monospacedSystemFont(ofSize: 12, weight: .regular); text.textContainerInset = NSSize(width: 16, height: 16)
        scroll.documentView = text; window.contentView?.addSubview(scroll); logText = text; logWindow = window
        render(); window.center(); NSApp.activate(ignoringOtherApps: true); window.makeKeyAndOrderFront(nil)
    }
    @objc private func showHelp(_ sender: Any?) {
        let alert = NSAlert(); alert.messageText = "Codex Relay"
        alert.informativeText = "1. 保持 Codex 桌面端与本应用运行。\n2. 打开“选择监控任务”，勾选一个或多个任务。\n3. 明确因额度耗尽而失败时，等待额度恢复，再向原会话发送续跑消息。\n\n正常完成、手动中止和其他错误不会自动重试。电脑休眠时暂停检查，唤醒后继续。退出本应用会停止监控。\n\n监控名单与记录保存在 ~/Library/Application Support/Codex Relay。使用 Codex 私有本地接口，桌面端升级后可能需要适配。"
        alert.addButton(withTitle: "知道了"); NSApp.activate(ignoringOtherApps: true); alert.runModal()
    }
    @objc private func quit(_ sender: Any?) { NSApp.terminate(nil) }
    func applicationWillTerminate(_ notification: Notification) {
        didQuit = true; restartTimer?.invalidate(); send(["command": "shutdown"])
        input?.closeFile(); helper?.terminate()
    }
}

// An OS-held lock prevents duplicate menu bar instances, and releases on crashes.
let support = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/Codex Relay")
try? FileManager.default.createDirectory(at: support, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
let lockDescriptor = Darwin.open(support.appendingPathComponent("application.lock").path, O_CREAT | O_RDWR, 0o600)
if lockDescriptor < 0 || flock(lockDescriptor, LOCK_EX | LOCK_NB) != 0 { exit(0) }
let app = NSApplication.shared
let delegate = RelayApp()
app.delegate = delegate
app.run()
