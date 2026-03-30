import { expect } from "chai";
import { ethers } from "hardhat";
import {
  KnowledgeContent,
  NativeVotes,
  RevenueVault,
  TreasuryNative,
} from "../typechain-types";
import {
  KnowledgeContent__factory,
  NativeVotes__factory,
  RevenueVault__factory,
  TreasuryNative__factory,
} from "../typechain-types";

async function mineBlocks(n: number) {
  for (let i = 0; i < n; i++) {
    await ethers.provider.send("evm_mine", []);
  }
}

describe("KnowledgeContent (Treasury Native + Metadata)", function () {
  it("Should allow owner to configure content policy", async function () {
    const [deployer] = await ethers.getSigners();

    const contentFactory = (await ethers.getContractFactory(
      "KnowledgeContent"
    )) as unknown as KnowledgeContent__factory;
    const content: KnowledgeContent = await contentFactory.deploy();
    await content.waitForDeployment();

    await expect(content.setContentPolicy(2, true, 5))
      .to.emit(content, "ContentPolicyUpdated")
      .withArgs(2, true, 5);

    expect(await content.editLockVotes()).to.equal(2n);
    expect(await content.allowDeleteAfterVote()).to.equal(true);
    expect(await content.maxVersionsPerContent()).to.equal(5n);
  });

  it("Should store the first version and append history on update", async function () {
    const [, author] = await ethers.getSigners();

    const contentFactory = (await ethers.getContractFactory(
      "KnowledgeContent"
    )) as unknown as KnowledgeContent__factory;
    const content: KnowledgeContent = await contentFactory.deploy();
    await content.waitForDeployment();

    await content.connect(author).registerContent(
      "QmOldHash",
      "Old Title",
      "Old Description"
    );

    expect(await content.contentVersionCount(1)).to.equal(1n);

    const v1 = await content.getContentVersion(1, 1);
    expect(v1[0]).to.equal("QmOldHash");
    expect(v1[1]).to.equal("Old Title");
    expect(v1[2]).to.equal("Old Description");

    await expect(
      content
        .connect(author)
        .updateContent(1, "QmNewHash", "New Title", "New Description")
    )
      .to.emit(content, "ContentUpdated")
      .withArgs(1, author.address, "QmNewHash", "New Title", "New Description");

    await expect(
      content
        .connect(author)
        .updateContent(1, "QmFinalHash", "Final Title", "Final Description")
    )
      .to.emit(content, "ContentVersionStored")
      .withArgs(1, 3, "QmFinalHash", "Final Title", "Final Description");

    expect(await content.contentVersionCount(1)).to.equal(3n);

    const stored = await content.contents(1);
    expect(stored.ipfsHash).to.equal("QmFinalHash");
    expect(stored.title).to.equal("Final Title");
    expect(stored.description).to.equal("Final Description");
    expect(stored.deleted).to.equal(false);
    expect(stored.latestVersion).to.equal(3n);
    expect(stored.lastUpdatedAt).to.be.gte(stored.timestamp);

    const v2 = await content.getContentVersion(1, 2);
    expect(v2[0]).to.equal("QmNewHash");
    expect(v2[1]).to.equal("New Title");
    expect(v2[2]).to.equal("New Description");

    const v3 = await content.getContentVersion(1, 3);
    expect(v3[0]).to.equal("QmFinalHash");
    expect(v3[1]).to.equal("Final Title");
    expect(v3[2]).to.equal("Final Description");
  });

  it("Should revert update after content receives votes", async function () {
    const [deployer, author] = await ethers.getSigners();

    const nativeVotesFactory = (await ethers.getContractFactory(
      "NativeVotes"
    )) as unknown as NativeVotes__factory;
    const nativeVotes: NativeVotes = await nativeVotesFactory.deploy(1, 1);
    await nativeVotes.waitForDeployment();

    const contentFactory = (await ethers.getContractFactory(
      "KnowledgeContent"
    )) as unknown as KnowledgeContent__factory;
    const content: KnowledgeContent = await contentFactory.deploy();
    await content.waitForDeployment();

    await content.setAntiSybil(
      await nativeVotes.getAddress(),
      ethers.parseEther("1")
    );

    await content.connect(author).registerContent("QmHash", "Title", "Desc");

    const voter = ethers.Wallet.createRandom().connect(ethers.provider);
    await deployer.sendTransaction({
      to: voter.address,
      value: ethers.parseEther("2"),
    });

    await nativeVotes.connect(voter).deposit({ value: ethers.parseEther("1") });
    await mineBlocks(1);
    await nativeVotes.connect(voter).activate();
    await content.connect(voter).vote(1);

    await expect(
      content
        .connect(author)
        .updateContent(1, "QmNewHash", "New Title", "New Description")
    ).to.be.revertedWith("edit locked");
  });

  it("Should allow update until editLockVotes is reached", async function () {
    const [deployer, author] = await ethers.getSigners();

    const nativeVotesFactory = (await ethers.getContractFactory(
      "NativeVotes"
    )) as unknown as NativeVotes__factory;
    const nativeVotes: NativeVotes = await nativeVotesFactory.deploy(1, 1);
    await nativeVotes.waitForDeployment();

    const contentFactory = (await ethers.getContractFactory(
      "KnowledgeContent"
    )) as unknown as KnowledgeContent__factory;
    const content: KnowledgeContent = await contentFactory.deploy();
    await content.waitForDeployment();

    await content.setContentPolicy(2, false, 20);
    await content.setAntiSybil(
      await nativeVotes.getAddress(),
      ethers.parseEther("1")
    );
    await content.connect(author).registerContent("QmHash", "Title", "Desc");

    const voter1 = ethers.Wallet.createRandom().connect(ethers.provider);
    const voter2 = ethers.Wallet.createRandom().connect(ethers.provider);

    for (const voter of [voter1, voter2]) {
      await deployer.sendTransaction({
        to: voter.address,
        value: ethers.parseEther("2"),
      });
      await nativeVotes
        .connect(voter)
        .deposit({ value: ethers.parseEther("1") });
      await mineBlocks(1);
      await nativeVotes.connect(voter).activate();
    }

    await content.connect(voter1).vote(1);
    await content
      .connect(author)
      .updateContent(1, "QmHashV2", "Title V2", "Desc V2");

    await content.connect(voter2).vote(1);

    await expect(
      content
        .connect(author)
        .updateContent(1, "QmHashV3", "Title V3", "Desc V3")
    ).to.be.revertedWith("edit locked");
  });

  it("Should preserve version history after delete and block reward actions", async function () {
    const [deployer, author] = await ethers.getSigners();

    const nativeVotesFactory = (await ethers.getContractFactory(
      "NativeVotes"
    )) as unknown as NativeVotes__factory;
    const nativeVotes: NativeVotes = await nativeVotesFactory.deploy(1, 1);
    await nativeVotes.waitForDeployment();

    const treasuryFactory = (await ethers.getContractFactory(
      "TreasuryNative"
    )) as unknown as TreasuryNative__factory;
    const treasury: TreasuryNative = await treasuryFactory.deploy(
      3600,
      ethers.parseEther("100")
    );
    await treasury.waitForDeployment();

    await deployer.sendTransaction({
      to: await treasury.getAddress(),
      value: ethers.parseEther("5"),
    });

    const contentFactory = (await ethers.getContractFactory(
      "KnowledgeContent"
    )) as unknown as KnowledgeContent__factory;
    const content: KnowledgeContent = await contentFactory.deploy();
    await content.waitForDeployment();

    await content.setAntiSybil(
      await nativeVotes.getAddress(),
      ethers.parseEther("1")
    );
    await content.setTreasury(await treasury.getAddress());
    await treasury.setSpender(await content.getAddress(), true);

    await content.connect(author).registerContent(
      "QmHashV1",
      "Title V1",
      "Desc V1"
    );
    await content
      .connect(author)
      .updateContent(1, "QmHashV2", "Title V2", "Desc V2");

    await expect(content.connect(author).deleteContent(1))
      .to.emit(content, "ContentDeleted")
      .withArgs(1, author.address, author.address);

    const stored = await content.contents(1);
    expect(stored.deleted).to.equal(true);
    expect(stored.latestVersion).to.equal(2n);
    expect(await content.contentVersionCount(1)).to.equal(2n);

    const v1 = await content.getContentVersion(1, 1);
    const v2 = await content.getContentVersion(1, 2);
    expect(v1[0]).to.equal("QmHashV1");
    expect(v2[0]).to.equal("QmHashV2");

    await expect(
      content.connect(author).updateContent(1, "QmNew", "New", "New")
    ).to.be.revertedWith("content deleted");

    const voter = ethers.Wallet.createRandom().connect(ethers.provider);
    await deployer.sendTransaction({
      to: voter.address,
      value: ethers.parseEther("2"),
    });
    await nativeVotes.connect(voter).deposit({ value: ethers.parseEther("1") });
    await mineBlocks(1);
    await nativeVotes.connect(voter).activate();

    await expect(content.connect(voter).vote(1)).to.be.revertedWith(
      "content deleted"
    );
    await expect(content.distributeReward(1)).to.be.revertedWith(
      "content deleted"
    );
  });

  it("Should allow author to restore deleted content and resume actions", async function () {
    const [deployer, author] = await ethers.getSigners();

    const nativeVotesFactory = (await ethers.getContractFactory(
      "NativeVotes"
    )) as unknown as NativeVotes__factory;
    const nativeVotes: NativeVotes = await nativeVotesFactory.deploy(1, 1);
    await nativeVotes.waitForDeployment();

    const contentFactory = (await ethers.getContractFactory(
      "KnowledgeContent"
    )) as unknown as KnowledgeContent__factory;
    const content: KnowledgeContent = await contentFactory.deploy();
    await content.waitForDeployment();

    await content.setAntiSybil(
      await nativeVotes.getAddress(),
      ethers.parseEther("1")
    );

    await content.connect(author).registerContent("QmHash", "Title", "Desc");
    await content.connect(author).deleteContent(1);

    await expect(content.connect(author).restoreContent(1))
      .to.emit(content, "ContentRestored")
      .withArgs(1, author.address, author.address);

    expect((await content.contents(1)).deleted).to.equal(false);

    const voter = ethers.Wallet.createRandom().connect(ethers.provider);
    await deployer.sendTransaction({
      to: voter.address,
      value: ethers.parseEther("2"),
    });
    await nativeVotes.connect(voter).deposit({ value: ethers.parseEther("1") });
    await mineBlocks(1);
    await nativeVotes.connect(voter).activate();

    await expect(content.connect(voter).vote(1))
      .to.emit(content, "Voted")
      .withArgs(1, voter.address);
  });

  it("Should allow owner to restore moderated content", async function () {
    const [deployer, author] = await ethers.getSigners();

    const contentFactory = (await ethers.getContractFactory(
      "KnowledgeContent"
    )) as unknown as KnowledgeContent__factory;
    const content: KnowledgeContent = await contentFactory.deploy();
    await content.waitForDeployment();

    await content.connect(author).registerContent("QmHash", "Title", "Desc");
    await content.connect(deployer).deleteContent(1);

    await expect(content.connect(deployer).restoreContent(1))
      .to.emit(content, "ContentRestored")
      .withArgs(1, deployer.address, author.address);

    expect((await content.contents(1)).deleted).to.equal(false);
  });

  it("Should allow author to delete voted content when policy enables it", async function () {
    const [deployer, author] = await ethers.getSigners();

    const nativeVotesFactory = (await ethers.getContractFactory(
      "NativeVotes"
    )) as unknown as NativeVotes__factory;
    const nativeVotes: NativeVotes = await nativeVotesFactory.deploy(1, 1);
    await nativeVotes.waitForDeployment();

    const contentFactory = (await ethers.getContractFactory(
      "KnowledgeContent"
    )) as unknown as KnowledgeContent__factory;
    const content: KnowledgeContent = await contentFactory.deploy();
    await content.waitForDeployment();

    await content.setContentPolicy(1, true, 20);
    await content.setAntiSybil(
      await nativeVotes.getAddress(),
      ethers.parseEther("1")
    );

    await content.connect(author).registerContent("QmHash", "Title", "Desc");

    const voter = ethers.Wallet.createRandom().connect(ethers.provider);
    await deployer.sendTransaction({
      to: voter.address,
      value: ethers.parseEther("2"),
    });
    await nativeVotes.connect(voter).deposit({ value: ethers.parseEther("1") });
    await mineBlocks(1);
    await nativeVotes.connect(voter).activate();
    await content.connect(voter).vote(1);

    await expect(content.connect(author).deleteContent(1))
      .to.emit(content, "ContentDeleted")
      .withArgs(1, author.address, author.address);
  });

  it("Should enforce maxVersionsPerContent", async function () {
    const [, author] = await ethers.getSigners();

    const contentFactory = (await ethers.getContractFactory(
      "KnowledgeContent"
    )) as unknown as KnowledgeContent__factory;
    const content: KnowledgeContent = await contentFactory.deploy();
    await content.waitForDeployment();

    await content.setContentPolicy(1, false, 2);
    await content.connect(author).registerContent(
      "QmHashV1",
      "Title V1",
      "Desc V1"
    );

    await content
      .connect(author)
      .updateContent(1, "QmHashV2", "Title V2", "Desc V2");

    await expect(
      content
        .connect(author)
        .updateContent(1, "QmHashV3", "Title V3", "Desc V3")
    ).to.be.revertedWith("max versions reached");
  });

  it("Should allow owner to delete content for moderation", async function () {
    const [deployer, author] = await ethers.getSigners();

    const nativeVotesFactory = (await ethers.getContractFactory(
      "NativeVotes"
    )) as unknown as NativeVotes__factory;
    const nativeVotes: NativeVotes = await nativeVotesFactory.deploy(1, 1);
    await nativeVotes.waitForDeployment();

    const contentFactory = (await ethers.getContractFactory(
      "KnowledgeContent"
    )) as unknown as KnowledgeContent__factory;
    const content: KnowledgeContent = await contentFactory.deploy();
    await content.waitForDeployment();

    await content.setAntiSybil(
      await nativeVotes.getAddress(),
      ethers.parseEther("1")
    );

    await content.connect(author).registerContent("QmHash", "Title", "Desc");

    const voter = ethers.Wallet.createRandom().connect(ethers.provider);
    await deployer.sendTransaction({
      to: voter.address,
      value: ethers.parseEther("2"),
    });

    await nativeVotes.connect(voter).deposit({ value: ethers.parseEther("1") });
    await mineBlocks(1);
    await nativeVotes.connect(voter).activate();
    await content.connect(voter).vote(1);

    await expect(content.connect(deployer).deleteContent(1))
      .to.emit(content, "ContentDeleted")
      .withArgs(1, deployer.address, author.address);

    expect((await content.contents(1)).deleted).to.equal(true);
  });

  it("Should accrue reward into Treasury and allow author to claim()", async function () {
    const [deployer, author] = await ethers.getSigners();

    const nativeVotesFactory = (await ethers.getContractFactory(
      "NativeVotes"
    )) as unknown as NativeVotes__factory;
    const nativeVotes: NativeVotes = await nativeVotesFactory.deploy(1, 1);
    await nativeVotes.waitForDeployment();

    const treasuryFactory = (await ethers.getContractFactory(
      "TreasuryNative"
    )) as unknown as TreasuryNative__factory;
    const treasury: TreasuryNative = await treasuryFactory.deploy(
      3600,
      ethers.parseEther("100")
    );
    await treasury.waitForDeployment();

    const contentFactory = (await ethers.getContractFactory(
      "KnowledgeContent"
    )) as unknown as KnowledgeContent__factory;
    const content: KnowledgeContent = await contentFactory.deploy();
    await content.waitForDeployment();

    await (
      await deployer.sendTransaction({
        to: await treasury.getAddress(),
        value: ethers.parseEther("5"),
      })
    ).wait();

    await (
      await content.setAntiSybil(
        await nativeVotes.getAddress(),
        ethers.parseEther("1")
      )
    ).wait();
    await (await content.setTreasury(await treasury.getAddress())).wait();
    await (await treasury.setSpender(await content.getAddress(), true)).wait();

    await content.connect(author).registerContent(
      "QmHashNewVersion",
      "My Awesome Article",
      "This is a detailed description of the content."
    );

    for (let i = 0; i < 10; i++) {
      const voter = ethers.Wallet.createRandom().connect(ethers.provider);

      await (
        await deployer.sendTransaction({
          to: voter.address,
          value: ethers.parseEther("2"),
        })
      ).wait();

      await (
        await nativeVotes
          .connect(voter)
          .deposit({ value: ethers.parseEther("1") })
      ).wait();

      await mineBlocks(1);
      await (await nativeVotes.connect(voter).activate()).wait();
      await (await content.connect(voter).vote(1)).wait();
    }

    await (await content.connect(author).distributeReward(1)).wait();

    expect(await content.rewardAccrualCount(1)).to.equal(1n);

    const pending = await treasury.pendingRewards(author.address);
    expect(pending).to.be.gt(0n);

    const before = await ethers.provider.getBalance(author.address);
    const tx = await treasury.connect(author).claim();
    await tx.wait();

    const after = await ethers.provider.getBalance(author.address);
    const pendingAfter = await treasury.pendingRewards(author.address);

    expect(pendingAfter).to.equal(0n);
    expect(after).to.be.gt(before);
    expect(after - before).to.be.lt(pending);
  });

  it("Should emit ContentRegistered with metadata and the first version", async function () {
    const [deployer] = await ethers.getSigners();

    const contentFactory = (await ethers.getContractFactory(
      "KnowledgeContent"
    )) as unknown as KnowledgeContent__factory;
    const content = await contentFactory.deploy();
    await content.waitForDeployment();

    const title = "Test Title";
    const desc = "Test Description";
    const hash = "QmTestNew";

    await expect(content.registerContent(hash, title, desc))
      .to.emit(content, "ContentRegistered")
      .withArgs(1, deployer.address, hash, title, desc);

    await expect(content.registerContent("QmTestTwo", "T2", "D2"))
      .to.emit(content, "ContentVersionStored")
      .withArgs(2, 1, "QmTestTwo", "T2", "D2");
  });

  it("Should revert getContentVersion for an invalid version", async function () {
    const contentFactory = (await ethers.getContractFactory(
      "KnowledgeContent"
    )) as unknown as KnowledgeContent__factory;
    const content = await contentFactory.deploy();
    await content.waitForDeployment();

    await content.registerContent("QmTest", "Title", "Desc");

    await expect(content.getContentVersion(1, 2)).to.be.revertedWith(
      "bad version"
    );
  });

  it("Should revert distributeReward when budget or pool is insufficient", async function () {
    const [deployer, author] = await ethers.getSigners();

    const nvFactory = (await ethers.getContractFactory(
      "NativeVotes"
    )) as unknown as NativeVotes__factory;
    const nativeVotes = await nvFactory.deploy(1, 1);
    await nativeVotes.waitForDeployment();

    const smallBudget = ethers.parseEther("0.0001");
    const tFactory = (await ethers.getContractFactory(
      "TreasuryNative"
    )) as unknown as TreasuryNative__factory;
    const treasury = await tFactory.deploy(3600, smallBudget);
    await treasury.waitForDeployment();

    await deployer.sendTransaction({
      to: await treasury.getAddress(),
      value: ethers.parseEther("0.00005"),
    });

    const cFactory = (await ethers.getContractFactory(
      "KnowledgeContent"
    )) as unknown as KnowledgeContent__factory;
    const content = await cFactory.deploy();
    await content.waitForDeployment();

    await content.setAntiSybil(
      await nativeVotes.getAddress(),
      ethers.parseEther("1")
    );
    await content.setTreasury(await treasury.getAddress());
    await treasury.setSpender(await content.getAddress(), true);

    await content.connect(author).registerContent("QmHash", "Title", "Desc");

    for (let i = 0; i < 2; i++) {
      const voter = ethers.Wallet.createRandom().connect(ethers.provider);
      await deployer.sendTransaction({
        to: voter.address,
        value: ethers.parseEther("2"),
      });
      await nativeVotes
        .connect(voter)
        .deposit({ value: ethers.parseEther("1") });
      await mineBlocks(1);
      await nativeVotes.connect(voter).activate();
      await content.connect(voter).vote(1);
    }

    await expect(content.connect(author).distributeReward(1)).to.be.reverted;
  });
  it("Should accrue reward incrementally when new votes arrive", async function () {
    const [deployer, author] = await ethers.getSigners();

    const nativeVotesFactory = (await ethers.getContractFactory(
      "NativeVotes"
    )) as unknown as NativeVotes__factory;
    const nativeVotes: NativeVotes = await nativeVotesFactory.deploy(1, 1);
    await nativeVotes.waitForDeployment();

    const treasuryFactory = (await ethers.getContractFactory(
      "TreasuryNative"
    )) as unknown as TreasuryNative__factory;
    const treasury: TreasuryNative = await treasuryFactory.deploy(
      3600,
      ethers.parseEther("100")
    );
    await treasury.waitForDeployment();

    await deployer.sendTransaction({
      to: await treasury.getAddress(),
      value: ethers.parseEther("5"),
    });

    const contentFactory = (await ethers.getContractFactory(
      "KnowledgeContent"
    )) as unknown as KnowledgeContent__factory;
    const content: KnowledgeContent = await contentFactory.deploy();
    await content.waitForDeployment();

    await content.setAntiSybil(
      await nativeVotes.getAddress(),
      ethers.parseEther("1")
    );
    await content.setTreasury(await treasury.getAddress());
    await treasury.setSpender(await content.getAddress(), true);

    await content.connect(author).registerContent("QmHash", "Title", "Desc");

    for (let i = 0; i < 5; i++) {
      const voter = ethers.Wallet.createRandom().connect(ethers.provider);
      await deployer.sendTransaction({
        to: voter.address,
        value: ethers.parseEther("2"),
      });
      await nativeVotes.connect(voter).deposit({ value: ethers.parseEther("1") });
      await mineBlocks(1);
      await nativeVotes.connect(voter).activate();
      await content.connect(voter).vote(1);
    }

    await expect(content.connect(author).distributeReward(1))
      .to.emit(content, "RewardAccrueRequested")
      .withArgs(1, author.address, 5n * 10n ** 15n, 5n);

    expect(await content.rewardSettledVotes(1)).to.equal(5n);
    expect(await treasury.pendingRewards(author.address)).to.equal(5n * 10n ** 15n);

    for (let i = 0; i < 3; i++) {
      const voter = ethers.Wallet.createRandom().connect(ethers.provider);
      await deployer.sendTransaction({
        to: voter.address,
        value: ethers.parseEther("2"),
      });
      await nativeVotes.connect(voter).deposit({ value: ethers.parseEther("1") });
      await mineBlocks(1);
      await nativeVotes.connect(voter).activate();
      await content.connect(voter).vote(1);
    }

    await expect(content.connect(author).distributeReward(1))
      .to.emit(content, "RewardAccrueRequested")
      .withArgs(1, author.address, 3n * 10n ** 15n, 8n);

    expect(await content.rewardSettledVotes(1)).to.equal(8n);
    expect(await treasury.pendingRewards(author.address)).to.equal(8n * 10n ** 15n);

    await expect(content.connect(author).distributeReward(1)).to.be.revertedWith(
      "no new votes"
    );
  });
  it("Should only allow the author to distribute reward", async function () {
    const [deployer, author] = await ethers.getSigners();

    const nativeVotesFactory = (await ethers.getContractFactory(
      "NativeVotes"
    )) as unknown as NativeVotes__factory;
    const nativeVotes: NativeVotes = await nativeVotesFactory.deploy(1, 1);
    await nativeVotes.waitForDeployment();

    const treasuryFactory = (await ethers.getContractFactory(
      "TreasuryNative"
    )) as unknown as TreasuryNative__factory;
    const treasury: TreasuryNative = await treasuryFactory.deploy(
      3600,
      ethers.parseEther("100")
    );
    await treasury.waitForDeployment();

    await deployer.sendTransaction({
      to: await treasury.getAddress(),
      value: ethers.parseEther("5"),
    });

    const contentFactory = (await ethers.getContractFactory(
      "KnowledgeContent"
    )) as unknown as KnowledgeContent__factory;
    const content: KnowledgeContent = await contentFactory.deploy();
    await content.waitForDeployment();

    await content.setAntiSybil(
      await nativeVotes.getAddress(),
      ethers.parseEther("1")
    );
    await content.setTreasury(await treasury.getAddress());
    await treasury.setSpender(await content.getAddress(), true);

    await content.connect(author).registerContent("QmHash", "Title", "Desc");

    const voter = ethers.Wallet.createRandom().connect(ethers.provider);
    await deployer.sendTransaction({
      to: voter.address,
      value: ethers.parseEther("2"),
    });
    await nativeVotes.connect(voter).deposit({ value: ethers.parseEther("1") });
    await mineBlocks(1);
    await nativeVotes.connect(voter).activate();
    await content.connect(voter).vote(1);

    await expect(content.connect(deployer).distributeReward(1)).to.be.revertedWith(
      "not author"
    );
  });

  it("Should collect register and update fees into RevenueVault", async function () {
    const [deployer, author] = await ethers.getSigners();

    const treasuryFactory = (await ethers.getContractFactory(
      "TreasuryNative"
    )) as unknown as TreasuryNative__factory;
    const treasury: TreasuryNative = await treasuryFactory.deploy(
      3600,
      ethers.parseEther("100")
    );
    await treasury.waitForDeployment();

    const revenueVaultFactory = (await ethers.getContractFactory(
      "RevenueVault"
    )) as unknown as RevenueVault__factory;
    const revenueVault: RevenueVault = await revenueVaultFactory.deploy(
      await treasury.getAddress(),
      deployer.address,
      3000,
      ethers.parseEther("0.5"),
      ethers.parseEther("2"),
      ethers.parseEther("5"),
      ethers.parseEther("1"),
      3600
    );
    await revenueVault.waitForDeployment();

    const contentFactory = (await ethers.getContractFactory(
      "KnowledgeContent"
    )) as unknown as KnowledgeContent__factory;
    const content: KnowledgeContent = await contentFactory.deploy();
    await content.waitForDeployment();

    const registerFee = ethers.parseEther("0.01");
    const updateFee = ethers.parseEther("0.005");

    await content.setRevenueVault(await revenueVault.getAddress());
    await content.setContentFees(registerFee, updateFee);

    await expect(
      content
        .connect(author)
        .registerContent("QmPaidHash", "Paid Title", "Paid Description", {
          value: registerFee,
        })
    ).to.changeEtherBalance(revenueVault, registerFee);

    await expect(
      content
        .connect(author)
        .updateContent(1, "QmPaidHashV2", "Paid Title V2", "Paid Description V2", {
          value: updateFee,
        })
    ).to.changeEtherBalance(revenueVault, updateFee);

    await expect(
      content.connect(author).registerContent("QmBadFee", "Bad Fee", "Bad", {
        value: 0,
      })
    ).to.be.revertedWith("bad fee");
  });
});




