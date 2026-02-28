import { expect } from "chai";
import { ethers } from "hardhat";
import { NativeVotes__factory } from "../typechain-types";

describe("NativeVotes", function () {
  it("Should increase voting power after deposit", async function () {
    const [user] = await ethers.getSigners();

    const nativeVotes = await new NativeVotes__factory(user).deploy();
    await nativeVotes.waitForDeployment();

    await nativeVotes.connect(user).deposit({ value: ethers.parseEther("5") });

    const votes = await nativeVotes.getVotes(user.address);
    expect(votes).to.equal(ethers.parseEther("5"));
  });

  it("Should decrease voting power after withdraw", async function () {
    const [user] = await ethers.getSigners();

    const nativeVotes = await new NativeVotes__factory(user).deploy();
    await nativeVotes.waitForDeployment();

    await nativeVotes.connect(user).deposit({ value: ethers.parseEther("5") });
    await nativeVotes.connect(user).withdraw(ethers.parseEther("2"));

    const votes = await nativeVotes.getVotes(user.address);
    expect(votes).to.equal(ethers.parseEther("3"));
  });
});