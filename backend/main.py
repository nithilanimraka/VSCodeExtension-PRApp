from fastapi import FastAPI

app = FastAPI()


@app.get("/")
async def root():
    return {"message": "Hello World"}

from fastapi import FastAPI, HTTPException
import httpx
import os

app = FastAPI()

# Replace 'YOUR-TOKEN' with your actual GitHub token or set it as an environment variable.
GITHUB_TOKEN = os.getenv("GITHUB_TOKEN", "YOUR-TOKEN")
GITHUB_API_VERSION = "2022-11-28"

@app.get("/repos/{owner}/{repo}/pulls")
async def get_pull_requests(owner: str, repo: str):
    url = f"https://api.github.com/repos/{owner}/{repo}/pulls"
    headers = {
        "Authorization": f"token {GITHUB_TOKEN}",
        "X-GitHub-Api-Version": GITHUB_API_VERSION,
    }
    
    async with httpx.AsyncClient() as client:
        response = await client.get(url, headers=headers)
    
    if response.status_code != 200:
        raise HTTPException(status_code=response.status_code, detail=response.text)
    
    return response.json()
