/**
 * NFTGuard — Sepolia deployment script
 * Run:  npm run deploy:sepolia
 *
 * Corresponds to report milestone "Deployment: final compiled system deployed
 * on an Ethereum Testnet (Sepolia)" — Table 1.2.
 */
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const network = hre.network.name;

  console.log("-".repeat(60));
  console.log(`Deploying NFTGuardMarketplace to: ${network}`);
  console.log(`Deployer wallet:                  ${deployer.address}`);
  const balance = await hre.ethers.provider.getBalance(deployer.address);
  console.log(`Deployer balance:                 ${hre.ethers.formatEther(balance)} ETH`);
  console.log("-".repeat(60));

  if (balance === 0n && network === "sepolia") {
    console.error(
      "\nX Wallet has 0 Sepolia ETH. Get free test ETH from a faucet first:\n" +
      "  https://sepoliafaucet.com  or  https://www.alchemy.com/faucets/ethereum-sepolia\n"
    );
    process.exit(1);
  }

  const Factory = await hre.ethers.getContractFactory("NFTGuardMarketplace");
  const contract = await Factory.deploy();
  await contract.waitForDeployment();

  const address = await contract.getAddress();
  console.log(`\n[OK] NFTGuardMarketplace deployed at: ${address}`);

  // Persist deployment info + ABI for the backend
  const artifact = await hre.artifacts.readArtifact("NFTGuardMarketplace");
  const out = {
    network,
    address,
    deployer: deployer.address,
    deployedAt: new Date().toISOString(),
    abi: artifact.abi,
  };

  const deploymentsDir = path.join(__dirname, "..", "deployments");
  const backendAbiDir = path.join(__dirname, "..", "backend", "abi");
  fs.mkdirSync(deploymentsDir, { recursive: true });
  fs.mkdirSync(backendAbiDir, { recursive: true });
  fs.writeFileSync(path.join(deploymentsDir, `${network}.json`), JSON.stringify(out, null, 2));
  fs.writeFileSync(path.join(backendAbiDir, "NFTGuardMarketplace.json"), JSON.stringify(out, null, 2));

  console.log(`[OK] ABI + address written to backend/abi/NFTGuardMarketplace.json`);
  console.log("\nNEXT STEPS:");
  console.log(`  1. Add to your .env files:   CONTRACT_ADDRESS=${address}`);
  console.log(`  2. View on Etherscan:        https://sepolia.etherscan.io/address/${address}`);
  console.log(`  3. (optional) Verify source: npx hardhat verify --network sepolia ${address}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
