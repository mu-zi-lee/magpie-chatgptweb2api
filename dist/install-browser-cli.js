import { managedBrowserExecutable } from "./browser-install.js";
import { publicError } from "./errors.js";
try {
    process.stdout.write(`${await managedBrowserExecutable()}\n`);
}
catch (error) {
    process.stderr.write(`${publicError(error).message}\n`);
    process.exitCode = 1;
}
