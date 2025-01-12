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
import { isAmong } from "tsafe/isAmong";

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

        const keycloakVersion = (() => {
            const major = version.split(".")[0];

            return `${parseInt(major[0] + major[1])}.${parseInt(major[2] + major[3])}.${parseInt(major[4] + major[5])}`;
        })();

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

    const PATTERNFLY_MODULES = ["react-core", "react-icons", "react-styles", "react-table"] as const;

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

            let modifiedSourceCode = (await readFile()).toString("utf8");

            for (const name of PATTERNFLY_MODULES) {
                modifiedSourceCode = modifiedSourceCode.replaceAll(
                    `"@patternfly/${name}"`,
                    `"${new Array(fileRelativePath.split(pathSep).length).fill("..").join("/") || ".."}/@patternfly/${name}"`
                );
            }

            if (fileRelativePath === pathJoin("user-profile", "UserProfileFields.tsx")) {
                modifiedSourceCode = modifiedSourceCode.replace(
                    `import { ScrollForm } from "../main";`,
                    `export { ScrollForm } from "../scroll-form/ScrollForm";`
                );
            }

            await writeFile({
                fileRelativePath,
                modifiedData: Buffer.from(
                    [
                        ...(fileRelativePath.endsWith(".ts") || fileRelativePath.endsWith(".tsx")
                            ? ["/* eslint-disable */", "", "// @ts-nocheck", ""]
                            : []),
                        modifiedSourceCode
                    ].join("\n"),
                    "utf8"
                )
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
    let isKeycloakSelectPatched = false;

    transformCodebase({
        srcDirPath: extractedDirPath,
        destDirPath: pathJoin(distDirPath, "keycloak-theme", "shared", "keycloak-ui-shared"),
        transformSourceCode: ({ fileRelativePath, sourceCode }) => {
            if (fileRelativePath === "package.json") {
                keycloakUiSharedVersion = JSON.parse(sourceCode.toString("utf8"))["version"];
                return;
            }

            if (fileRelativePath === "select/KeycloakSelect.tsx") {
                const contentBefore = sourceCode.toString("utf8");

                const contentAfter = contentBefore.replace(
                    "KeycloakSelectProps<>",
                    "KeycloakSelectProps"
                );

                assert(contentBefore !== contentAfter);

                isKeycloakSelectPatched = true;

                return { modifiedSourceCode: Buffer.from(contentAfter, "utf8") };
            }

            return { modifiedSourceCode: sourceCode };
        }
    });

    for (const name of PATTERNFLY_MODULES) {
        const dirPath = pathJoin(distDirPath, "keycloak-theme", "shared", "@patternfly", name);

        if (!fs.existsSync(dirPath)) {
            fs.mkdirSync(dirPath, { recursive: true });
        }

        fs.writeFileSync(
            pathJoin(dirPath, "index.tsx"),
            Buffer.from(
                [
                    `// eslint-disable-next-line react-refresh/only-export-components`,
                    `export * from "@patternfly/${name}";`
                ].join("\n"),
                "utf8"
            )
        );
    }

    assert(typeof keycloakUiSharedVersion === "string");
    assert(isKeycloakSelectPatched);

    distPackageJson.peerDependencies = await (async () => {
        const { dependencies, peerDependencies, devDependencies } = (await fetch(
            `https://unpkg.com/@keycloak/keycloak-ui-shared@${keycloakUiSharedVersion}/package.json`,
            fetchOptions
        ).then(response => response.json())) as {
            dependencies?: Record<string, string>;
            peerDependencies?: Record<string, string>;
            devDependencies?: Record<string, string>;
        };

        const dependenciesAndPeerDependencies = Object.fromEntries(
            Object.entries({
                ...dependencies,
                ...peerDependencies
            }).filter(([moduleName]) => !isAmong(["react-dom"], moduleName))
        );

        const typeNames = Object.keys(dependenciesAndPeerDependencies).map(name =>
            name.startsWith("@") ? `@types/${name.substring(1).replace("/", "__")}` : `@types/${name}`
        );

        return {
            ...dependenciesAndPeerDependencies,
            ...Object.fromEntries(
                Object.entries(devDependencies ?? {}).filter(([name]) => {
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

    for (const basename of ["README.md", "LICENSE"]) {
        fs.copyFileSync(
            pathJoin(getThisCodebaseRootDirPath(), basename),
            pathJoin(distDirPath, basename)
        );
    }

    console.log(
        chalk.green(
            `\n\nPulled @keycloak/keycloak-ui-shared@${keycloakUiSharedVersion} from keycloak version ${keycloakVersion}`
        )
    );
})();
