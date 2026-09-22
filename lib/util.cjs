const
    fs = require("node:fs"),
    path = require("node:path"),
    { createHash } = require("node:crypto");

function writeChanged(file, content) {
    if (!fs.existsSync(file) || fs.readFileSync(file, "utf8") !== content)
        fs.writeFileSync(file, content);
}

function stripComments(text) {
    // Keep /// <reference> directives: they are ordering input, not comments.
    return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/(?!\/).*$/gm, "");
}

function stamp(file) {
    const stat = fs.statSync(file, { throwIfNoEntry: false });
    return stat == null ? null : [stat.mtimeMs, stat.size];
}

function hashFile(file) {
    try {
        return createHash("sha1").update(fs.readFileSync(file)).digest("hex");
    }
    catch {
        return null;
    }
}

function relativeTo(root, file) {
    return path.relative(root, file).split(path.sep).join("/");
}

function realPath(file) {
    // tsc --listFilesOnly may print canonical paths through a symlink
    // (/private/var/... instead of /var/... on macOS), so compare real paths.
    try {
        return fs.realpathSync.native(file);
    }
    catch {
        return path.resolve(file);
    }
}

function insidePath(root, file) {
    const relative = path.relative(realPath(root), realPath(file));
    if (relative === "" || relative.startsWith(".." + path.sep) || relative === ".." || path.isAbsolute(relative))
        return null;
    return path.resolve(root, relative);
}

function isInside(root, file) {
    const relative = path.relative(realPath(root), realPath(file));
    return relative === "" || (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative));
}

module.exports = { fs, path, writeChanged, stripComments, stamp, hashFile, relativeTo, insidePath, isInside };
