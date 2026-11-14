// swift-tools-version: 5.9
// GR Mod's native side on iOS, as a local Capacitor plugin: `npx cap sync ios` lists it in
// ios/App/CapApp-SPM/Package.swift (by the npm name "grmod-camera" → "GrmodCamera").
import PackageDescription

let package = Package(
    name: "GrmodCamera",
    platforms: [.iOS(.v15)],
    products: [
        .library(name: "GrmodCamera", targets: ["GrCamera"])
    ],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", exact: "8.6.0"),
        .package(url: "https://github.com/weichsel/ZIPFoundation.git", exact: "0.9.19")
    ],
    targets: [
        .target(
            name: "GrCamera",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "Cordova", package: "capacitor-swift-pm"),
                .product(name: "ZIPFoundation", package: "ZIPFoundation")
            ],
            path: "ios/Sources/GrCamera"
        )
    ]
)
