import { expect } from "chai";
import { ethers } from "hardhat";

describe("RewardToken Contract", function () {

  it("Should mint initial supply to deployer", async function () {

    const [owner] = await ethers.getSigners();

    const TokenFactory = await ethers.getContractFactory("RewardToken");
    const token = await TokenFactory.deploy();
    await token.waitForDeployment();

    const balance = await token.balanceOf(owner.address);

    expect(balance).to.be.gt(0n);
  });

  it("Should allow owner to mint tokens", async function () {

    const [owner, user] = await ethers.getSigners();

    const TokenFactory = await ethers.getContractFactory("RewardToken");
    const token = await TokenFactory.deploy();
    await token.waitForDeployment();

    await token.mint(user.address, ethers.parseEther("10"));

    expect(await token.balanceOf(user.address))
      .to.equal(ethers.parseEther("10"));
  });

});