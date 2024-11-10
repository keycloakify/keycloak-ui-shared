import { downloadAndExtractArchive } from "./tools/downloadAndExtractArchive";
import { join as pathJoin, relative as pathRelative, sep as pathSep } from "path";
import { getThisCodebaseRootDirPath } from "./tools/getThisCodebaseRootDirPath";
import { getProxyFetchOptions } from "./tools/fetchProxyOptions";
import { transformCodebase } from "./tools/transformCodebase";
import { isInside } from "./tools/isInside";
import { assert } from "tsafe/assert";
import fetch from "make-fetch-happen";
import * as fs from "fs";
import chalk from "chalk";
import { id } from "tsafe/id";

(async () => {
    const distDirPath = pathJoin(getThisCodebaseRootDirPath(), "dist");

    if (!fs.existsSync(distDirPath)) {
        fs.mkdirSync(distDirPath, { recursive: true });
    }

    const { keycloakVersion, distPackageJson } = (() => {
        const parsedPackageJson = JSON.parse(
            fs.readFileSync(pathJoin(getThisCodebaseRootDirPath(), "package.json")).toString("utf8")
        );

        const { name, repository, author, license, homepage, version } = parsedPackageJson;
        const keycloakVersion: string = version.slice(0, -3);

        return {
            keycloakVersion,
            distPackageJson: {
                name,
                version,
                repository,
                license,
                author,
                homepage,
                peerDependencies: id<Record<string, string>>({}),
                publishConfig: {
                    access: "public"
                }
            }
        };
    })();

    const fetchOptions = getProxyFetchOptions({
        npmConfigGetCwd: getThisCodebaseRootDirPath()
    });

    const cacheDirPath = pathJoin(getThisCodebaseRootDirPath(), "node_modules", ".cache", "scripts");

    const { extractedDirPath } = await downloadAndExtractArchive({
        url: `https://github.com/keycloak/keycloak/archive/refs/tags/${keycloakVersion}.zip`,
        cacheDirPath,
        fetchOptions,
        uniqueIdOfOnArchiveFile: "download_keycloak_source",
        onArchiveFile: async ({ fileRelativePath, readFile, writeFile }) => {
            // Remove the first segment of the path
            fileRelativePath = fileRelativePath.split(pathSep).slice(1).join(pathSep);

            {
                const dirPath = pathJoin("js", "libs", "ui-shared");

                if (
                    !isInside({
                        filePath: fileRelativePath,
                        dirPath
                    })
                ) {
                    return;
                }

                fileRelativePath = pathRelative(dirPath, fileRelativePath);
            }

            if (/\.test\.[a-z0-9]{2,3}/.test(fileRelativePath)) {
                return;
            }

            if (fileRelativePath === "package.json") {
                await writeFile({
                    fileRelativePath: "package.json"
                });

                return;
            }

            {
                const dirPath = "src";

                if (
                    !isInside({
                        filePath: fileRelativePath,
                        dirPath
                    })
                ) {
                    return;
                }

                fileRelativePath = pathRelative(dirPath, fileRelativePath);
            }

            if (fileRelativePath === "vite-env.d.ts") {
                return;
            }

            let sourceCode = (await readFile()).toString("utf8");

            await writeFile({
                fileRelativePath: pathJoin(fileRelativePath),
                modifiedData: Buffer.from(sourceCode, "utf8")
            });

            if (fileRelativePath === "main.ts") {
                await writeFile({
                    fileRelativePath: "index.ts",
                    modifiedData: Buffer.from(["export * from './main';", ""].join("\n"), "utf8")
                });
            }
        }
    });

    let keycloakUiSharedVersion: string | undefined;

    transformCodebase({
        srcDirPath: extractedDirPath,
        destDirPath: pathJoin(distDirPath, "keycloak-theme", "shared", "keycloak-ui-shared"),
        transformSourceCode: ({ fileRelativePath, sourceCode }) => {
            if (fileRelativePath === "package.json") {
                keycloakUiSharedVersion = JSON.parse(sourceCode.toString("utf8"))["version"];

                return;
            }

            return { modifiedSourceCode: sourceCode };
        }
    });

    assert(typeof keycloakUiSharedVersion === "string");

    distPackageJson.peerDependencies = await (async () => {
        const { dependencies, peerDependencies, devDependencies } = await fetch(
            `https://unpkg.com/@keycloak/keycloak-ui-shared@${keycloakUiSharedVersion}/package.json`,
            fetchOptions
        ).then(response => response.json());

        const typeNames = [
            ...Object.keys(dependencies ?? {}),
            ...Object.keys(peerDependencies ?? {})
        ].map(name =>
            name.startsWith("@") ? `@types/${name.substring(1).replace("/", "__")}` : `@types/${name}`
        );

        return {
            ...dependencies,
            ...peerDependencies,
            ...Object.fromEntries(
                Object.entries(devDependencies).filter(([name]) => {
                    if (!name.startsWith("@types")) {
                        return false;
                    }

                    return typeNames.includes(name);
                })
            )
        };
    })();

    fs.writeFileSync(
        pathJoin(distDirPath, "package.json"),
        Buffer.from(JSON.stringify(distPackageJson, null, 2), "utf8")
    );

    console.log(
        chalk.green(
            `\n\nPulled @keycloak/keycloak-shared-ui@${keycloakUiSharedVersion} from keycloak version ${keycloakVersion}`
        )
    );
})();
