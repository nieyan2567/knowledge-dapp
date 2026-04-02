import { expect } from "chai";
import { ethers } from "hardhat";
import {
  FaucetVault,
  RevenueVault,
  TreasuryNative,
} from "../typechain-types";
import {
  FaucetVault__factory,
  RevenueVault__factory,
  TreasuryNative__factory,
} from "../typechain-types";

function encodeClaimHash(input: {
  chainId: bigint;
  faucetVault: string;
  recipient: string;
  amount: bigint;
  deadline: bigint;
  nonce: string;
}) {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["uint256", "address", "address", "uint256", "uint256", "bytes32"],
      [
        input.chainId,
        input.faucetVault,
        input.recipient,
        input.amount,
        input.deadline,
        input.nonce,
      ]
    )
  );
}

describe("FaucetVault", function () {
  async function deployFaucetVault() {
    const [deployer, signerWallet] = await ethers.getSigners();
    const factory = (await ethers.getContractFactory(
      "FaucetVault"
    )) as unknown as FaucetVault__factory;

    const faucetVault: FaucetVault = await factory.deploy(
      signerWallet.address,
      ethers.parseEther("2"),
      ethers.parseEther("1"),
      24 * 3600,
      24 * 3600,
      ethers.parseEther("6")
    );
    await faucetVault.waitForDeployment();

    return { deployer, signerWallet, faucetVault };
  }

  async function signClaim(input: {
    signerWallet: Awaited<ReturnType<typeof ethers.getSigners>>[number];
    faucetVault: FaucetVault;
    recipient: string;
    amount: bigint;
    deadline: bigint;
    nonce: string;
  }) {
    const network = await ethers.provider.getNetwork();
    const claimHash = encodeClaimHash({
      chainId: network.chainId,
      faucetVault: await input.faucetVault.getAddress(),
      recipient: input.recipient,
      amount: input.amount,
      deadline: input.deadline,
      nonce: input.nonce,
    });

    return input.signerWallet.signMessage(ethers.getBytes(claimHash));
  }

  it("allows a relayer to submit a valid authorized claim", async function () {
    const [deployer, signerWallet, recipient, relayer] = await ethers.getSigners();
    const factory = (await ethers.getContractFactory(
      "FaucetVault"
    )) as unknown as FaucetVault__factory;
    const faucetVault: FaucetVault = await factory.deploy(
      signerWallet.address,
      ethers.parseEther("2"),
      ethers.parseEther("1"),
      24 * 3600,
      24 * 3600,
      ethers.parseEther("6")
    );
    await faucetVault.waitForDeployment();

    await deployer.sendTransaction({
      to: await faucetVault.getAddress(),
      value: ethers.parseEther("10"),
    });

    const amount = await faucetVault.claimAmount();
    const deadline = BigInt((await ethers.provider.getBlock("latest"))!.timestamp + 600);
    const nonce = ethers.id("claim-1");
    const signature = await signClaim({
      signerWallet,
      faucetVault,
      recipient: recipient.address,
      amount,
      deadline,
      nonce,
    });

    await expect(
      faucetVault
        .connect(relayer)
        .claim(recipient.address, amount, deadline, nonce, signature)
    )
      .to.emit(faucetVault, "Claimed")
      .withArgs(relayer.address, recipient.address, amount, deadline, nonce);

    expect(await faucetVault.epochSpent()).to.equal(amount);
    expect(await faucetVault.lastClaimAt(recipient.address)).to.be.gt(0n);
  });

  it("rejects replayed claims and enforces cooldown", async function () {
    const [deployer, signerWallet, recipient, relayer] = await ethers.getSigners();
    const factory = (await ethers.getContractFactory(
      "FaucetVault"
    )) as unknown as FaucetVault__factory;
    const faucetVault: FaucetVault = await factory.deploy(
      signerWallet.address,
      ethers.parseEther("2"),
      ethers.parseEther("1"),
      24 * 3600,
      24 * 3600,
      ethers.parseEther("6")
    );
    await faucetVault.waitForDeployment();

    await deployer.sendTransaction({
      to: await faucetVault.getAddress(),
      value: ethers.parseEther("10"),
    });

    const amount = await faucetVault.claimAmount();
    const deadline = BigInt((await ethers.provider.getBlock("latest"))!.timestamp + 600);
    const firstNonce = ethers.id("claim-2");
    const firstSignature = await signClaim({
      signerWallet,
      faucetVault,
      recipient: recipient.address,
      amount,
      deadline,
      nonce: firstNonce,
    });

    await faucetVault
      .connect(relayer)
      .claim(recipient.address, amount, deadline, firstNonce, firstSignature);

    await expect(
      faucetVault
        .connect(relayer)
        .claim(recipient.address, amount, deadline, firstNonce, firstSignature)
    ).to.be.revertedWith("already used");

    const secondNonce = ethers.id("claim-3");
    const secondSignature = await signClaim({
      signerWallet,
      faucetVault,
      recipient: recipient.address,
      amount,
      deadline,
      nonce: secondNonce,
    });

    await expect(
      faucetVault
        .connect(relayer)
        .claim(recipient.address, amount, deadline, secondNonce, secondSignature)
    ).to.be.revertedWith("cooldown");
  });

  it("supports rotating the signer and enforcing epoch budgets", async function () {
    const [deployer, signerWallet, recipient, relayer, nextSigner] =
      await ethers.getSigners();
    const factory = (await ethers.getContractFactory(
      "FaucetVault"
    )) as unknown as FaucetVault__factory;
    const faucetVault: FaucetVault = await factory.deploy(
      signerWallet.address,
      ethers.parseEther("2"),
      ethers.parseEther("1"),
      0,
      24 * 3600,
      ethers.parseEther("3")
    );
    await faucetVault.waitForDeployment();

    await deployer.sendTransaction({
      to: await faucetVault.getAddress(),
      value: ethers.parseEther("10"),
    });

    await faucetVault.setSigner(nextSigner.address);

    const amount = await faucetVault.claimAmount();
    const deadline = BigInt((await ethers.provider.getBlock("latest"))!.timestamp + 600);
    const nonce = ethers.id("claim-4");

    const oldSignature = await signClaim({
      signerWallet,
      faucetVault,
      recipient: recipient.address,
      amount,
      deadline,
      nonce,
    });

    await expect(
      faucetVault.connect(relayer).claim(recipient.address, amount, deadline, nonce, oldSignature)
    ).to.be.revertedWith("bad signer");

    const newSignature = await signClaim({
      signerWallet: nextSigner,
      faucetVault,
      recipient: recipient.address,
      amount,
      deadline,
      nonce,
    });

    await faucetVault
      .connect(relayer)
      .claim(recipient.address, amount, deadline, nonce, newSignature);

    const anotherRecipient = (await ethers.getSigners())[5];
    const secondNonce = ethers.id("claim-5");
    const secondSignature = await signClaim({
      signerWallet: nextSigner,
      faucetVault,
      recipient: anotherRecipient.address,
      amount,
      deadline,
      nonce: secondNonce,
    });

    await expect(
      faucetVault
        .connect(relayer)
        .claim(
          anotherRecipient.address,
          amount,
          deadline,
          secondNonce,
          secondSignature
        )
    ).to.be.revertedWith("budget exceeded");
  });

  it("accepts periodic revenue payouts from RevenueVault", async function () {
    const [deployer, faucetSigner, caller] = await ethers.getSigners();
    const treasuryFactory = (await ethers.getContractFactory(
      "TreasuryNative"
    )) as unknown as TreasuryNative__factory;
    const treasury: TreasuryNative = await treasuryFactory.deploy(
      7 * 24 * 3600,
      ethers.parseEther("100")
    );
    await treasury.waitForDeployment();

    const faucetFactory = (await ethers.getContractFactory(
      "FaucetVault"
    )) as unknown as FaucetVault__factory;
    const faucetVault: FaucetVault = await faucetFactory.deploy(
      faucetSigner.address,
      ethers.parseEther("2"),
      ethers.parseEther("1"),
      24 * 3600,
      24 * 3600,
      ethers.parseEther("10")
    );
    await faucetVault.waitForDeployment();

    const revenueVaultFactory = (await ethers.getContractFactory(
      "RevenueVault"
    )) as unknown as RevenueVault__factory;
    const revenueVault: RevenueVault = await revenueVaultFactory.deploy(
      await treasury.getAddress(),
      await faucetVault.getAddress(),
      3000,
      ethers.parseEther("0.5"),
      ethers.parseEther("2"),
      ethers.parseEther("5"),
      ethers.parseEther("1"),
      3600
    );
    await revenueVault.waitForDeployment();

    const before = await ethers.provider.getBalance(await faucetVault.getAddress());

    await deployer.sendTransaction({
      to: await revenueVault.getAddress(),
      value: ethers.parseEther("5"),
    });

    await revenueVault.connect(caller).rebalance();

    const after = await ethers.provider.getBalance(await faucetVault.getAddress());
    expect(after - before).to.equal(ethers.parseEther("1.5"));
  });
});
