import { expect } from "chai";
import { ethers } from "hardhat";

describe("KnowledgeContent Contract", function () {

    let token: any;
    let content: any;
    let owner: any;
    let user1: any;
    let user2: any;

    beforeEach(async function () {

        [owner, user1, user2] = await ethers.getSigners();

        const TokenFactory = await ethers.getContractFactory("RewardToken");
        token = await TokenFactory.deploy();
        await token.waitForDeployment();

        const ContentFactory = await ethers.getContractFactory("KnowledgeContent");

        content = await ContentFactory.deploy(
            await token.getAddress()
        );

        await content.waitForDeployment();

        // RewardToken owner -> KnowledgeContent
        await token.transferOwnership(await content.getAddress());
    });

    it("Should register content successfully", async function () {

        await content.connect(user1)
            .registerContent("QmHash123");

        const c = await content.contents(1);

        expect(c.author).to.equal(user1.address);
    });


    it("Should allow voting once per user", async function () {

        await content.connect(user1)
            .registerContent("QmHash123");

        await content.connect(user2).vote(1);

        const c = await content.contents(1);

        expect(c.voteCount).to.equal(1);
    });


    it("Should prevent duplicate voting", async function () {

        await content.connect(user1)
            .registerContent("QmHash123");

        await content.connect(user2).vote(1);

        await expect(
            content.connect(user2).vote(1)
        ).to.be.reverted;
    });


    it("Should distribute reward after enough votes", async function () {

        await content.connect(user1)
            .registerContent("QmHash123");

        // 默认 minVotesToReward = 10

        for (let i = 0; i < 10; i++) {

            const wallet = ethers.Wallet.createRandom()
                .connect(ethers.provider);

            await owner.sendTransaction({
                to: wallet.address,
                value: ethers.parseEther("1")
            });

            await content.connect(wallet).vote(1);
        }

        await content.distributeReward(1);

        const balance = await token.balanceOf(user1.address);

        expect(balance).to.be.gt(0n);
    });

    it("Should emit ContentRegistered event", async function () {

        await expect(
            content.connect(user1)
                .registerContent("QmHash123")
        )
            .to.emit(content, "ContentRegistered")
            .withArgs(
                1,
                user1.address,
                "QmHash123"
            );

    });

});